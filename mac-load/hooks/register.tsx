import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Levels, Reading } from '../types'
import {
  ALERT_COOLDOWN,
  FRESH_FOR,
  SYSCTL_NAMES,
  alertOf,
  appleScriptString,
  appsOf,
  cpuOf,
  detailsOf,
  isReading,
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
  worstOf,
} from './format'

const CALM: Levels = { cpu: 'normal', memory: 'normal', simulators: 'normal' }

const readingAtom = atom({ plugin: 'MacLoad', key: 'reading' } as const, null, { shape: 'reading-2' })
const levelsAtom = atom({ plugin: 'MacLoad', key: 'levels' } as const, CALM)
const stoppedAtom = atom({ plugin: 'MacLoad', key: 'isStopped' } as const, false)
const failuresAtom = atom({ plugin: 'MacLoad', key: 'failures' } as const, 0)
const workedAtom = atom({ plugin: 'MacLoad', key: 'hasWorked' } as const, false)
const alertedAtAtom = atom({ plugin: 'MacLoad', key: 'alertedAt' } as const, 0)

const POLL_MS = 30_000
// Room for a struggling Mac to answer: that is when a reading matters most.
const TIMEOUT_MS = 10_000
// Failed readings in a row after which the mod gives up, on a system it has never read.
const MAX_FAILURES = 3
// The store keys: set once a reading has worked on this Mac, for every later chat; the
// latest reading, which every open chat shows rather than each reading the Mac itself;
// and when any chat last alerted.
const WORKED = 'worked'
const SHARED = 'reading'
const ALERTED = 'alertedAt'

// Absolute paths, so no program of the same name earlier on the PATH runs instead; the C
// locale, so numbers come with decimal points. ps alone runs in UTF-8, which keeps app
// names such as "Café" whole where C would escape them; its numbers parse either way.
// Each only reads.
const IOSTAT = ['/usr/sbin/iostat', '-n0', '-c', '2', '-w', '2']
const PS = ['/bin/ps', '-A', '-o', 'pid=,ppid=,pcpu=,comm=']
const SYSCTL = ['/usr/sbin/sysctl', ...SYSCTL_NAMES]
const TOP = ['/usr/bin/top', '-l', '1', '-o', 'mem', '-stats', 'pid,mem']
const SIMCTL = ['/usr/bin/xcrun', 'simctl', 'list', 'devices', 'booted', '--json']
const OSASCRIPT = '/usr/bin/osascript'
const C = { LC_ALL: 'C' }
const UTF8 = { LC_ALL: 'en_US.UTF-8' }

// These live as long as this load of the module; a hot reload drops the old timer itself.
let timer: { cancel: () => void } | undefined
let isPolling = false
let shown: string | undefined

// What a command printed, or undefined when it cannot start or runs out of time. It runs
// in / rather than the session's folder, which may since have been deleted.
async function run($: EngineInterface, argv: readonly string[], env: Record<string, string> = C) {
  try {
    return await $.process.run(argv, { cwd: '/', timeoutMs: TIMEOUT_MS, env })
  } catch {
    return undefined
  }
}

// Reads the Mac once; undefined when the cores, or the CPU by any means, cannot be read.
// Each app's memory is read too `withMemory`, or while memory is strained and the culprit
// is wanted.
async function measure($: EngineInterface, withMemory: boolean): Promise<Reading | undefined> {
  const [iostat, ps, sysctl] = await Promise.all([run($, IOSTAT), run($, PS, UTF8), run($, SYSCTL)])
  // sysctl exits 1 when this Mac lacks one of the names, and writes the others all the same.
  const { cores, ...system } = parseSysctl(sysctl?.stdout ?? '')
  const processes = ps?.exitCode === 0 ? parsePs(ps.stdout) : []

  if (cores === undefined) {
    return undefined
  }

  // A Mac too busy for iostat's two seconds still answers ps.
  const cpu = (iostat?.exitCode === 0 ? parseIostat(iostat.stdout) : undefined) ?? cpuOf(processes, cores)

  if (cpu === undefined) {
    return undefined
  }

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

// Posts an overload as a macOS notification, which arrives at the top right of the screen
// as the person's other alerts do, rather than over the transcript. Once per overload
// across every open chat: the first to see it claims it in the store. Where no
// notification can be posted, the chat's own toast says it instead.
async function alert($: EngineInterface, title: string, body: string, now: number) {
  try {
    const last = await $.store.get(ALERTED)

    if (typeof last === 'number' && now - last < ALERT_COOLDOWN) {
      return
    }

    await $.store.set(ALERTED, now)
  } catch {
    // Without the store, this chat's own cooldown still keeps it to one alert.
  }

  const script = `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`
  const posted = await run($, [OSASCRIPT, '-e', script])

  if (posted?.exitCode !== 0) {
    $.ui.toast(`${title}: ${body}`, { timeoutMs: 10_000 })
  }
}

// The reading another chat stored within FRESH_FOR, if any.
async function sharedReading($: EngineInterface, now: number) {
  try {
    const stored = await $.store.get(SHARED)

    return isReading(stored) && now - stored.at < FRESH_FOR ? stored : undefined
  } catch {
    return undefined
  }
}

async function share($: EngineInterface, reading: Reading) {
  try {
    await $.store.set(SHARED, reading)
  } catch {
    // Other chats read the Mac themselves.
  }
}

async function take($: EngineInterface) {
  const shared = await sharedReading($, await $.clock.now())
  const reading = shared ?? (await measure($, false))
  const now = await $.clock.now()

  if (reading !== undefined && shared === undefined) {
    await share($, reading)
  }

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

  const overload = alertOf(reading, levels)

  if (overload !== undefined && worstOf(before) !== 'overloaded' && now - (await read($, alertedAtAtom)) >= ALERT_COOLDOWN) {
    await update($, alertedAtAtom, () => now)
    await alert($, overload.title, overload.body, now)
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

// Starts the readings once per load of this module: at the session's start, which fires
// again after a reload, and on each reply in case that start's hook failed.
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
      // A slow Mac is when it is wanted, often while a turn is still running.
      immediate: true,
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

  // A /clear ends the session's state but not this module: the line is drawn afresh.
  on('session.end', async ($, e, next) => {
    shown = undefined

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
