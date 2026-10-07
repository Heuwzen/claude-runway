import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Reading } from '../types'
import { detailsOf, levelOf, parseCores, parseLoadavg, parseMemoryFree, parseSimulators, statusOf, toastOf } from './format'

const readingAtom = atom({ plugin: 'mac-load', key: 'reading' } as const, null)
const levelAtom = atom({ plugin: 'mac-load', key: 'level' } as const, 'normal')
const stoppedAtom = atom({ plugin: 'mac-load', key: 'isStopped' } as const, false)
const failuresAtom = atom({ plugin: 'mac-load', key: 'failures' } as const, 0)

const POLL_MS = 30_000
const TIMEOUT_MS = 5000
// A lone slow or failed read should not end the meter for good; the first one, or this many in a row, does.
const MAX_FAILURES = 3

// Both live only as long as this load of the module; a hot reload cancels the old timer itself.
let timer: { cancel: () => void } | undefined
let isPolling = false

// What a command printed, or undefined when it is missing, fails or times out.
async function run($: EngineInterface, argv: string[]) {
  try {
    const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: TIMEOUT_MS })

    return exitCode === 0 ? stdout : undefined
  } catch {
    return undefined
  }
}

async function stop($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  $.ui.status(undefined)
  await update($, stoppedAtom, () => true)
}

async function take($: EngineInterface, previous: Reading | null) {
  const [loadText, coresText, memoryText, simulatorText] = await Promise.all([
    run($, ['sysctl', '-n', 'vm.loadavg']),
    run($, ['sysctl', '-n', 'hw.logicalcpu']),
    run($, ['memory_pressure', '-Q']),
    run($, ['xcrun', 'simctl', 'list', 'devices', 'booted', '--json']),
  ])
  const load = parseLoadavg(loadText ?? '')

  if (load === undefined) {
    const failures = (await read($, failuresAtom)) + 1
    await update($, failuresAtom, () => failures)

    if (previous === null || failures >= MAX_FAILURES) {
      await stop($)
    }

    return
  }

  await update($, failuresAtom, () => 0)
  // The core count never changes, so an unreadable one falls back to the last.
  const cores = parseCores(coresText ?? '') ?? previous?.cores

  if (cores === undefined) {
    return
  }

  const reading: Reading = {
    load,
    cores,
    memoryFree: parseMemoryFree(memoryText ?? ''),
    simulators: parseSimulators(simulatorText ?? ''),
  }
  const before = await read($, levelAtom)
  const level = levelOf(reading, before)
  const toast = toastOf(reading, before, level)

  await update($, readingAtom, () => reading)
  await update($, levelAtom, () => level)
  $.ui.status(statusOf(reading, level))

  if (toast !== undefined) {
    $.ui.toast(toast, { timeoutMs: 10_000 })
  }
}

// Reads the Mac once. Never throws; one read runs at a time.
async function poll($: EngineInterface) {
  if (isPolling || (await read($, stoppedAtom))) {
    return
  }

  isPolling = true

  try {
    await take($, await read($, readingAtom))
  } catch {
    // A failed read leaves the last status on screen until the next one.
  } finally {
    isPolling = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mac-load',
      description: "Show the Mac's load, memory and booted simulators",
    })

    timer?.cancel()
    timer = $.clock.every(POLL_MS, () => void poll($))
    // Not awaited: a slow command must not hold the session's start.
    void poll($)

    return next(e)
  })

  on('command.run', { command: 'mac-load' }, async $ => {
    await poll($)

    const reading = await read($, readingAtom)

    if (reading === null) {
      return { text: 'No Mac load reading here: this needs macOS.' }
    }

    return { text: detailsOf(reading, await read($, levelAtom)) }
  })
}
