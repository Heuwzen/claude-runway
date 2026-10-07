import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Levels, Reading } from '../types'
import {
  SYSCTL_NAMES,
  TOAST_COOLDOWN,
  appsOf,
  detailsOf,
  keepTop,
  levelsOf,
  memoryLevelOf,
  parseIostat,
  parsePs,
  parseSimulators,
  parseSysctl,
  parseTop,
  simulatorsOf,
  statusOf,
  toastOf,
  worstOf,
} from './format'

const CALM: Levels = { cpu: 'normal', memory: 'normal', simulators: 'normal' }

const readingAtom = atom({ plugin: 'mac-load', key: 'reading' } as const, null)
const levelsAtom = atom({ plugin: 'mac-load', key: 'levels' } as const, CALM)
const stoppedAtom = atom({ plugin: 'mac-load', key: 'isStopped' } as const, false)
const failuresAtom = atom({ plugin: 'mac-load', key: 'failures' } as const, 0)
const workedAtom = atom({ plugin: 'mac-load', key: 'hasWorked' } as const, false)
const toastedAtAtom = atom({ plugin: 'mac-load', key: 'toastedAt' } as const, 0)

const POLL_MS = 30_000
// Room for a struggling Mac to answer: that is when a reading matters most.
const TIMEOUT_MS = 10_000
// Failed readings in a row after which the mod gives up, on a system it has never read.
const MAX_FAILURES = 3
// The store key set once a reading has worked on this Mac, for every later chat.
const WORKED = 'worked'

// Absolute paths, so no program of the same name earlier on the PATH runs instead; the C
// locale, so numbers come with decimal points. Each only reads.
const IOSTAT = ['/usr/sbin/iostat', '-n0', '-c', '2', '-w', '2']
const PS = ['/bin/ps', '-A', '-o', 'pid=,pcpu=,comm=']
const SYSCTL = ['/usr/sbin/sysctl', ...SYSCTL_NAMES]
const TOP = ['/usr/bin/top', '-l', '1', '-o', 'mem', '-n', '100', '-stats', 'pid,mem']
const SIMCTL = ['/usr/bin/xcrun', 'simctl', 'list', 'devices', 'booted', '--json']
const ENV = { LC_ALL: 'C' }

// These live as long as this load of the module; a hot reload drops the old timer itself.
let timer: { cancel: () => void } | undefined
let isPolling = false
let shown: string | undefined

// What a command printed, or undefined when it cannot start or runs out of time.
async function run($: EngineInterface, argv: readonly string[]) {
  try {
    return await $.process.run(argv, { timeoutMs: TIMEOUT_MS, env: ENV })
  } catch {
    return undefined
  }
}

// Reads the Mac once; undefined when the CPU or the cores cannot be read. Each app's memory
// is read too `withMemory`, or while memory is strained and the culprit is wanted.
async function measure($: EngineInterface, withMemory: boolean): Promise<Reading | undefined> {
  const [iostat, ps, sysctl] = await Promise.all([run($, IOSTAT), run($, PS), run($, SYSCTL)])
  const cpu = iostat?.exitCode === 0 ? parseIostat(iostat.stdout) : undefined
  // sysctl exits 1 when this Mac lacks one of the names, and writes the others all the same.
  const { cores, ...system } = parseSysctl(sysctl?.stdout ?? '')

  if (cpu === undefined || cores === undefined) {
    return undefined
  }

  const processes = ps?.exitCode === 0 ? parsePs(ps.stdout) : []
  let footprints: Map<number, number> | undefined

  if (processes.length > 0 && (withMemory || memoryLevelOf(system) !== 'normal')) {
    const top = await run($, TOP)
    footprints = top?.exitCode === 0 ? parseTop(top.stdout) : undefined
  }

  return {
    at: await $.clock.now(),
    cpu,
    cores,
    ...system,
    simulators: simulatorsOf(processes),
    apps: keepTop(appsOf(processes, footprints)),
  }
}

function show($: EngineInterface, text: string | undefined) {
  if (text !== shown) {
    shown = text
    $.ui.status(text)
  }
}

async function stop($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  // Cleared even when this load of the module drew nothing: an earlier one may have.
  shown = undefined
  $.ui.status(undefined)
  await update($, stoppedAtom, () => true)
}

// Whether a reading has worked on this Mac before, in any chat: then a failure is a Mac
// too busy to answer in time, not a system without these commands.
async function hasWorked($: EngineInterface) {
  if (await read($, workedAtom)) {
    return true
  }

  try {
    return (await $.store.get(WORKED)) === true
  } catch {
    return false
  }
}

async function markWorked($: EngineInterface) {
  if (await read($, workedAtom)) {
    return
  }

  await update($, workedAtom, () => true)

  try {
    await $.store.set(WORKED, true)
  } catch {
    // Only a later chat's patience with a slow first reading depends on it.
  }
}

async function take($: EngineInterface) {
  const reading = await measure($, false)
  const now = await $.clock.now()

  if (reading === undefined) {
    const failures = (await read($, failuresAtom)) + 1
    const last = await read($, readingAtom)
    await update($, failuresAtom, () => failures)

    if (failures >= MAX_FAILURES && !(await hasWorked($))) {
      await stop($)
    } else if (last !== null) {
      // The last reading stays, with its age once it is stale.
      show($, statusOf(last, await read($, levelsAtom), now))
    }

    return
  }

  await update($, failuresAtom, () => 0)
  await markWorked($)

  const before = await read($, levelsAtom)
  const levels = levelsOf(reading, before)
  await update($, readingAtom, () => reading)
  await update($, levelsAtom, () => levels)
  show($, statusOf(reading, levels, now))

  const text = toastOf(reading, levels)

  if (text !== undefined && worstOf(before) !== 'overloaded' && now - (await read($, toastedAtAtom)) >= TOAST_COOLDOWN) {
    $.ui.toast(text, { timeoutMs: 10_000 })
    await update($, toastedAtAtom, () => now)
  }
}

// Reads the Mac once. Never throws; one reading runs at a time.
async function poll($: EngineInterface) {
  if (isPolling || (await read($, stoppedAtom))) {
    return
  }

  isPolling = true

  try {
    await take($)
  } catch {
    // The last line stays on screen until the next reading.
  } finally {
    isPolling = false
  }
}

// Starts the readings once per load of this module: at the session's start, and from later
// events in case a hot reload dropped the timer.
function ensurePolling($: EngineInterface) {
  if (timer !== undefined) {
    return
  }

  timer = $.clock.every(POLL_MS, () => void poll($))
  // Not awaited: a slow command must not hold up the session.
  void poll($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mac-load',
      description: 'Show what is using your Mac: CPU, memory and simulators, by app',
    })

    ensurePolling($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (!(await read($, stoppedAtom))) {
      ensurePolling($)
    }

    return next(e)
  })

  on('command.run', { command: 'mac-load' }, async $ => {
    const reading = await measure($, true)

    if (reading === undefined) {
      return {
        text: (await hasWorked($))
          ? 'The Mac did not answer in time. Try again in a moment.'
          : 'Nothing to read here: mac-load needs macOS.',
      }
    }

    const levels = levelsOf(reading, await read($, levelsAtom))
    const simctl = reading.simulators > 0 ? await run($, SIMCTL) : undefined
    const simulators = simctl?.exitCode === 0 ? parseSimulators(simctl.stdout) : []

    return { text: detailsOf(reading, levels, simulators) }
  })
}
