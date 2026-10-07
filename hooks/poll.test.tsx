import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const START = { cwd: '/tmp', surface: 'desktop', isInteractive: true } as const
const COMMAND = {
  command: 'mac-load',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const
const SIMULATOR_RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0'

type World = {
  // The text each command prints; undefined makes that command fail.
  loadavg?: string
  cores?: string
  memory?: string
  simulators?: string
  // Commands that cannot start, as when the program is missing.
  missing?: string[]
}

const simulators = (count: number) =>
  JSON.stringify({
    devices: {
      [SIMULATOR_RUNTIME]: Array.from({ length: count }, (_, i) => ({ name: `iPhone ${i + 1}`, state: 'Booted' })),
    },
  })

const calm = (): World => ({
  loadavg: '{ 3.12 2.95 2.80 }',
  cores: '10',
  memory: 'The system has 17179869184 (1048576 pages with a page size of 16384).\nSystem-wide memory free percentage: 40%\n',
  simulators: simulators(0),
})

const loadavg = (load1: number) => `{ ${load1.toFixed(2)} 5.00 5.00 }`

// Stands in for the host beneath the plugin: its commands (answered from `world`, and
// counted in `calls`), its clock, its status line and its toasts.
function engine(on: On, world: World) {
  const toasts: { text: string; timeoutMs?: number }[] = []
  const status: (string | undefined)[] = []
  const calls: string[][] = []
  const timeouts: (number | undefined)[] = []
  const clock = mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    timeouts.push(e.init?.timeoutMs)
    const [program, ...args] = e.argv

    if (program === undefined || world.missing?.includes(program)) {
      throw new Error(`spawn ${program} ENOENT`)
    }

    const text =
      program === 'sysctl' ? (args.includes('vm.loadavg') ? world.loadavg : world.cores)
      : program === 'memory_pressure' ? world.memory
      : world.simulators

    return {
      value: {
        exitCode: text === undefined ? 1 : 0,
        stdout: text ?? '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.status', (_, e) => {
    status.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push({ text: e.text, timeoutMs: e.timeoutMs })

    return { value: undefined }
  })

  return { toasts, status, calls, timeouts, clock }
}

test('shows the load on session start, with no mark when calm', async ($, on) => {
  const { status, toasts, clock } = engine(on, calm())
  await $.session.start(START)
  await clock.settle()

  expect(status.at(-1)).toBe('Mac load 3.1 / 10 cores · 40% memory free')
  expect(toasts).toEqual([])
})

test('reads with short timeouts, and only with commands that write nothing', async ($, on) => {
  const { calls, timeouts, clock } = engine(on, calm())
  await $.session.start(START)
  await clock.settle()

  expect(calls).toEqual([
    ['sysctl', '-n', 'vm.loadavg'],
    ['sysctl', '-n', 'hw.logicalcpu'],
    ['memory_pressure', '-Q'],
    ['xcrun', 'simctl', 'list', 'devices', 'booted', '--json'],
  ])
  expect(timeouts.length).toBe(4)
  expect(timeouts.every(ms => ms !== undefined && ms <= 5000)).toBe(true)
})

test('polls every 30 seconds', async ($, on) => {
  const world = calm()
  const { status, clock } = engine(on, world)
  await $.session.start(START)
  await clock.settle()
  world.loadavg = loadavg(6.2)
  await clock.advance(29_000)
  expect(status.at(-1)).toContain('Mac load 3.1')
  await clock.advance(1_000)

  expect(status.at(-1)).toBe('Mac load 6.2 / 10 cores · 40% memory free')
})

test('counts the booted simulators, and says nothing about them when xcrun is missing', async ($, on) => {
  const world = { ...calm(), simulators: simulators(2) }
  const { status, clock } = engine(on, world)
  await $.session.start(START)
  await clock.settle()
  expect(status.at(-1)).toBe('Mac load 3.1 / 10 cores · 40% memory free · 2 simulators')

  world.missing = ['xcrun']
  await clock.advance(30_000)
  expect(status.at(-1)).toBe('Mac load 3.1 / 10 cores · 40% memory free')
})

test('toasts for 10 seconds on entering busy, once, and on escalating to overloaded', async ($, on) => {
  const world = { ...calm(), simulators: simulators(3), loadavg: loadavg(18) }
  const { toasts, status, clock } = engine(on, world)
  await $.session.start(START)
  await clock.settle()

  expect(toasts).toEqual([{ text: 'Mac is busy: load 18 on 10 cores, 3 simulators booted', timeoutMs: 10_000 }])
  expect(status.at(-1)).toBe('▲ Mac load 18.0 / 10 cores · 40% memory free · 3 simulators')

  await clock.advance(30_000)
  expect(toasts).toHaveLength(1)

  world.loadavg = loadavg(34)
  world.memory = 'System-wide memory free percentage: 9%\n'
  await clock.advance(30_000)

  expect(toasts.at(-1)).toEqual({
    text: 'Mac is overloaded: load 34 on 10 cores, 9% memory free. Shut down simulators or pause builds.',
    timeoutMs: 10_000,
  })
  expect(status.at(-1)).toStartWith('◆ Mac load 34.0')
  expect(toasts).toHaveLength(2)
})

test('keeps its level until the Mac is well clear, without toasting again', async ($, on) => {
  const world = { ...calm(), loadavg: loadavg(16) }
  const { toasts, status, clock } = engine(on, world)
  await $.session.start(START)
  await clock.settle()
  expect(toasts).toHaveLength(1)

  world.loadavg = loadavg(13)
  await clock.advance(30_000)
  expect(status.at(-1)).toStartWith('▲ ')

  world.loadavg = loadavg(11)
  await clock.advance(30_000)
  expect(status.at(-1)).toStartWith('Mac load 11.0')

  world.loadavg = loadavg(16)
  await clock.advance(30_000)
  expect(toasts).toHaveLength(2)
})

test('clears the status line and stops polling when sysctl is missing', async ($, on) => {
  const world: World = { ...calm(), missing: ['sysctl'] }
  const { status, calls, clock } = engine(on, world)
  await $.session.start(START)
  await clock.settle()

  expect(status).toEqual([undefined])

  const before = calls.length
  world.missing = []
  await clock.advance(120_000)
  expect(calls.length).toBe(before)
  expect(status).toEqual([undefined])
})

test('stops when sysctl fails with an error code, as on a system without the key', async ($, on) => {
  const { status, calls, clock } = engine(on, { ...calm(), loadavg: undefined })
  await $.session.start(START)
  await clock.settle()
  const before = calls.length
  await clock.advance(60_000)

  expect(status).toEqual([undefined])
  expect(calls.length).toBe(before)
})

test('survives a lone failed reading but stops after three in a row', async ($, on) => {
  const world = calm()
  const { status, calls, clock } = engine(on, world)
  await $.session.start(START)
  await clock.settle()

  world.loadavg = undefined
  await clock.advance(30_000)
  expect(status.at(-1)).toContain('Mac load 3.1')

  world.loadavg = loadavg(4)
  await clock.advance(30_000)
  expect(status.at(-1)).toContain('Mac load 4.0')

  world.loadavg = undefined
  await clock.advance(30_000)
  await clock.advance(30_000)
  expect(status.at(-1)).toContain('Mac load 4.0')
  await clock.advance(30_000)
  expect(status.at(-1)).toBe(undefined)

  const before = calls.length
  await clock.advance(60_000)
  expect(calls.length).toBe(before)
})

test('keeps the last core count when it cannot be read', async ($, on) => {
  const world = calm()
  const { status, clock } = engine(on, world)
  await $.session.start(START)
  await clock.settle()

  world.cores = undefined
  world.loadavg = loadavg(5)
  await clock.advance(30_000)
  expect(status.at(-1)).toBe('Mac load 5.0 / 10 cores · 40% memory free')
})

test('leaves memory out when memory_pressure is missing', async ($, on) => {
  const { status, clock } = engine(on, { ...calm(), missing: ['memory_pressure'] })
  await $.session.start(START)
  await clock.settle()

  expect(status.at(-1)).toBe('Mac load 3.1 / 10 cores')
})

test('/mac-load details the load, the memory and the simulators', async ($, on) => {
  const { clock } = engine(on, { ...calm(), simulators: simulators(2) })
  await $.session.start(START)
  await clock.settle()

  const { text } = await $.command.run(COMMAND)
  expect(text).toBe(
    [
      'Mac load: normal',
      'Load: 3.1 (1 min), 3.0 (5 min), 2.8 (15 min), on 10 cores',
      'Busy from load 15, overloaded from 30',
      'Memory free: 40%',
      'Simulators booted: 2',
      '  iPhone 1 (iOS 26.0)',
      '  iPhone 2 (iOS 26.0)',
      'Shut them all down: xcrun simctl shutdown all',
    ].join('\n'),
  )
})

test('/mac-load reads fresh', async ($, on) => {
  const world = calm()
  const { clock } = engine(on, world)
  await $.session.start(START)
  await clock.settle()

  world.loadavg = loadavg(20)
  expect((await $.command.run(COMMAND)).text).toContain('Mac load: busy')
})

test('/mac-load says so when there is nothing to read', async ($, on) => {
  const { clock } = engine(on, { ...calm(), missing: ['sysctl'] })
  await $.session.start(START)
  await clock.settle()

  expect((await $.command.run(COMMAND)).text).toBe('No Mac load reading here: this needs macOS.')
})
