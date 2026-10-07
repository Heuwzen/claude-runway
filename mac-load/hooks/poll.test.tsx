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
const measured = () => ({ context: { window: 200_000 }, rateLimits: [], changed: [] })

const CLAUDE = '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)'
const SWIFT = '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend'
const RUNTIME = '/Library/Developer/CoreSimulator/Volumes/iOS_24A5380i/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.0.simruntime/Contents/Resources/RuntimeRoot'
const POSTER = `${RUNTIME}/System/Library/PrivateFrameworks/PosterBoard.framework/PlugIns/EmojiPosterExtension.appex/EmojiPosterExtension`
const LAUNCHD_SIM = `${RUNTIME}/sbin/launchd_sim`
const WINDOW_SERVER = '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer'

type World = {
  // What each program writes; undefined makes it exit 1.
  iostat?: string
  ps?: string
  sysctl?: string
  top?: string
  simctl?: string
  osascript?: string
  // Programs that cannot start, as on a system without them.
  missing?: string[]
}

// The two rows `iostat -n0 -c 2 -w 2` writes: since boot, then the last two seconds.
const iostat = (busy: number) =>
  ['      cpu    load average', ' us sy id   1m   5m   15m', ' 10  5 85  2.00 2.00 2.00', ` ${busy} 0 ${100 - busy}  2.00 2.00 2.00`].join('\n')

const sysctl = ({ available = 44, pressure = 1, load = 3 } = {}) =>
  [
    'hw.logicalcpu: 10',
    'hw.memsize: 17179869184',
    `kern.memorystatus_level: ${available}`,
    `kern.memorystatus_vm_pressure_level: ${pressure}`,
    `vm.loadavg: { ${load.toFixed(2)} 5.00 5.00 }`,
    'vm.swapusage: total = 3072.00M  used = 1586.19M  free = 1485.81M  (encrypted)',
  ].join('\n')

// Rows of pid, CPU and program, with a parent where it matters (launchd's otherwise).
const ps = (rows: ([number, number, string] | [number, number, string, number])[]) =>
  rows.map(([pid, cpu, command, ppid = 1]) => `${pid} ${ppid} ${cpu.toFixed(1)} ${command}`).join('\n')

const top = (rows: [number, string][]) =>
  ['Processes: 828 total, 4 running', '', 'PID    MEM  ', ...rows.map(([pid, mem]) => `${pid}  ${mem}`)].join('\n')

const BOOTED = JSON.stringify({
  devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [{ name: 'iPhone 17 Pro', state: 'Booted' }] },
})

const calm = (): World => ({
  iostat: iostat(28),
  sysctl: sysctl(),
  ps: ps([[601, 40, WINDOW_SERVER], [91104, 60, CLAUDE], [44001, 0, LAUNCHD_SIM]]),
  top: top([[91104, '1240M'], [601, '760M'], [44001, '12M']]),
  simctl: BOOTED,
  osascript: '',
})

// Xcode building on every core, with Claude beside it.
const building = (): [number, number, string][] => [
  ...Array.from({ length: 8 }, (_, i): [number, number, string] => [5000 + i, 100, SWIFT]),
  [91104, 60, CLAUDE],
]

const PROGRAMS: Record<string, keyof World> = {
  '/usr/sbin/iostat': 'iostat',
  '/bin/ps': 'ps',
  '/usr/sbin/sysctl': 'sysctl',
  '/usr/bin/top': 'top',
  '/usr/bin/xcrun': 'simctl',
  '/usr/bin/osascript': 'osascript',
}

// Stands in for the host beneath the plugin: its commands (answered from `world`, and
// counted in `calls`), its store (holding `stored`), its clock, status line and toasts.
function engine(on: On, world: World, stored: Record<string, unknown> = {}) {
  const toasts: string[] = []
  const status: (string | undefined)[] = []
  const calls: { argv: string[]; cwd?: string; timeoutMs?: number; env?: Record<string, string> }[] = []
  const commands: { name: string; immediate?: true }[] = []
  const clock = mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_, e) => {
    commands.push({ name: e.name, immediate: e.immediate })

    return { value: { command: e.name } }
  })
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => {
    stored[e.key] = e.value

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const [program = ''] = e.argv
    calls.push({ argv: [...e.argv], cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs, env: e.init?.env })

    if (world.missing?.includes(program) || PROGRAMS[program] === undefined) {
      throw new Error(`spawn ${program} ENOENT`)
    }

    const text = world[PROGRAMS[program]] as string | undefined

    return {
      value: { exitCode: text === undefined ? 1 : 0, stdout: text ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.status', (_, e) => {
    status.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  const programs = () => calls.map(call => call.argv[0])
  // The macOS notifications posted, by the AppleScript that posted each.
  const notifications = () => calls.filter(call => call.argv[0] === '/usr/bin/osascript').map(call => call.argv[2])

  return { toasts, status, calls, commands, programs, notifications, clock, stored }
}

test('shows CPU, memory and booted simulators from the start', async ($, on) => {
  const { status, toasts, clock } = engine(on, calm())
  await $.session.start(START)
  await clock.settle()

  expect(status).toEqual(['CPU 28% · Memory 56% · 1 sim'])
  expect(toasts).toEqual([])
})

test('reads with absolute paths, the C locale and timeouts, and only programs that read', async ($, on) => {
  const { calls, programs, clock } = engine(on, calm())
  await $.session.start(START)
  await clock.settle()

  expect(calls.map(call => call.argv)).toEqual([
    ['/usr/sbin/iostat', '-n0', '-c', '2', '-w', '2'],
    ['/bin/ps', '-A', '-o', 'pid=,ppid=,pcpu=,comm='],
    [
      '/usr/sbin/sysctl',
      'hw.logicalcpu',
      'hw.memsize',
      'kern.memorystatus_level',
      'kern.memorystatus_vm_pressure_level',
      'vm.loadavg',
      'vm.swapusage',
    ],
  ])
  expect(calls.every(call => call.timeoutMs === 10_000 && call.cwd === '/')).toBe(true)
  // ps in UTF-8 keeps app names whole; the rest in C, for their numbers.
  expect(calls.map(call => call.env?.LC_ALL)).toEqual(['C', 'en_US.UTF-8', 'C'])
  // Memory by app, and the simulators by name, are read only when wanted.
  expect(programs()).not.toContain('/usr/bin/top')
  expect(programs()).not.toContain('/usr/bin/xcrun')
})

test('reads again every 30 seconds, and leaves an unchanged line alone', async ($, on) => {
  const world = calm()
  const { status, clock } = engine(on, world)
  await $.session.start(START)
  await clock.settle()
  await clock.advance(30_000)
  expect(status).toHaveLength(1)

  world.iostat = iostat(41)
  await clock.advance(29_000)
  expect(status).toHaveLength(1)
  await clock.advance(1_000)
  expect(status.at(-1)).toBe('CPU 41% · Memory 56% · 1 sim')
})

test('names the busiest app while the CPU is busy, without a toast', async ($, on) => {
  const { status, toasts, clock } = engine(on, { ...calm(), iostat: iostat(92), sysctl: sysctl({ load: 14 }), ps: ps(building()) })
  await $.session.start(START)
  await clock.settle()

  expect(status.at(-1)).toBe('CPU ▲ 92% · Memory 56% · Xcode using 8 cores')
  expect(toasts).toEqual([])
})

test('holds a busy CPU until it falls well below where it started', async ($, on) => {
  const world = { ...calm(), iostat: iostat(86) }
  const { status, clock } = engine(on, world)
  await $.session.start(START)
  await clock.settle()
  expect(status.at(-1)).toStartWith('CPU ▲ 86%')

  world.iostat = iostat(72)
  await clock.advance(30_000)
  expect(status.at(-1)).toStartWith('CPU ▲ 72%')

  world.iostat = iostat(64)
  await clock.advance(30_000)
  expect(status.at(-1)).toStartWith('CPU 64%')
})

test('alerts once with a macOS notification as the CPU is overloaded, and not again for 10 minutes', async ($, on) => {
  const spike = ps([...Array.from({ length: 13 }, (_, i): [number, number, string] => [6000 + i, 24, POSTER]), [44001, 0, LAUNCHD_SIM], [91104, 60, CLAUDE]])
  const world = { ...calm(), iostat: iostat(100), sysctl: sysctl({ load: 40 }), ps: spike }
  const { status, toasts, notifications, clock } = engine(on, world)
  await $.session.start(START)
  await clock.settle()

  expect(status.at(-1)).toBe('CPU ◆ 100% · Memory 56% · Simulator using 3 cores')
  expect(notifications()).toEqual([
    'display notification "CPU at 100%, Simulator using 3 cores. Shut down simulators you are not using." with title "Mac is overloaded"',
  ])
  expect(toasts).toEqual([])

  await clock.advance(30_000)
  world.iostat = iostat(30)
  world.sysctl = sysctl({ load: 12 })
  await clock.advance(30_000)
  expect(status.at(-1)).toBe('CPU 30% · Memory 56% · 1 sim')

  world.iostat = iostat(100)
  world.sysctl = sysctl({ load: 40 })
  await clock.advance(30_000)
  expect(notifications()).toHaveLength(1)

  world.iostat = iostat(30)
  world.sysctl = sysctl({ load: 12 })
  await clock.advance(9 * 60_000)
  world.iostat = iostat(100)
  world.sysctl = sysctl({ load: 40 })
  await clock.advance(30_000)
  expect(notifications()).toHaveLength(2)
})

test('takes macOS at its word on memory, and names the largest app', async ($, on) => {
  const { status, programs, clock } = engine(on, { ...calm(), sysctl: sysctl({ available: 40, pressure: 2 }) })
  await $.session.start(START)
  await clock.settle()

  expect(status.at(-1)).toBe('CPU 28% · Memory ▲ 60% · Claude using 1.2 GB')
  expect(programs()).toContain('/usr/bin/top')
})

test('alerts when macOS says memory is critical', async ($, on) => {
  const { notifications, clock } = engine(on, { ...calm(), sysctl: sysctl({ available: 6, pressure: 4 }) })
  await $.session.start(START)
  await clock.settle()

  expect(notifications()).toEqual(['display notification "Memory nearly full, Claude using 1.2 GB." with title "Mac is overloaded"'])
})

test('leaves the alert to the chat that saw the overload first', async ($, on) => {
  // Another open chat posted it a minute ago.
  const { notifications, stored, clock } = engine(on, { ...calm(), iostat: iostat(100), sysctl: sysctl({ load: 40 }) }, { alertedAt: NOW - 60_000 })
  await $.session.start(START)
  await clock.settle()

  expect(notifications()).toEqual([])
  expect(stored.alertedAt).toBe(NOW - 60_000)
})

test('says it in a toast where no notification can be posted', async ($, on) => {
  const { toasts, clock } = engine(on, { ...calm(), iostat: iostat(100), sysctl: sysctl({ load: 40 }), missing: ['/usr/bin/osascript'] })
  await $.session.start(START)
  await clock.settle()

  // Claude's 0.6 cores are too small a share of a full Mac to blame, so no app is named.
  expect(toasts).toEqual(['Mac is overloaded: CPU at 100%.'])
})

test('marks three booted simulators, without a toast', async ($, on) => {
  const three = ps([[44001, 0, LAUNCHD_SIM], [44002, 0, LAUNCHD_SIM], [44003, 0, LAUNCHD_SIM], [601, 40, WINDOW_SERVER]])
  const { status, toasts, clock } = engine(on, { ...calm(), ps: three })
  await $.session.start(START)
  await clock.settle()

  expect(status.at(-1)).toBe('CPU 28% · Memory 56% · ▲ 3 sims')
  expect(toasts).toEqual([])
})

test('gives up quietly after three failed readings on a system it has never read', async ($, on) => {
  const world: World = { ...calm(), missing: Object.keys(PROGRAMS) }
  const { status, calls, clock } = engine(on, world)
  await $.session.start(START)
  await clock.settle()
  await clock.advance(60_000)

  expect(status).toEqual([undefined])

  const before = calls.length
  world.missing = []
  await clock.advance(120_000)
  await $.session.measure(measured())
  await clock.settle()
  expect(calls.length).toBe(before)
})

test('keeps going on a Mac it has read before, showing the age of the last reading', async ($, on) => {
  const world = calm()
  const { status, clock } = engine(on, world, { worked: true })
  await $.session.start(START)
  await clock.settle()

  // Nothing answers, as on a Mac too swamped to run anything in time.
  world.missing = Object.keys(PROGRAMS)
  await clock.advance(60_000)
  expect(status.at(-1)).toBe('CPU 28% · Memory 56% · 1 sim')
  await clock.advance(120_000)
  expect(status.at(-1)).toBe('CPU 28% · Memory 56% · 1 sim · as of 3m ago')

  world.missing = []
  world.iostat = iostat(35)
  await clock.advance(30_000)
  expect(status.at(-1)).toBe('CPU 35% · Memory 56% · 1 sim')
})

test('remembers for later chats that this Mac can be read', async ($, on) => {
  const { stored, clock } = engine(on, calm())
  await $.session.start(START)
  await clock.settle()

  expect(stored.worked).toBe(true)
})

test("starts reading from a reply when the session's start hook did not", async ($, on) => {
  const { status, clock } = engine(on, calm())
  await $.session.measure(measured())
  await clock.settle()

  expect(status).toEqual(['CPU 28% · Memory 56% · 1 sim'])
})

test('/mac-load breaks the Mac down by app', async ($, on) => {
  const world = { ...calm(), iostat: iostat(92), sysctl: sysctl({ load: 14 }), ps: ps([...building(), [44001, 0, LAUNCHD_SIM], [601, 40, WINDOW_SERVER]]) }
  const { clock } = engine(on, world)
  await $.session.start(START)
  await clock.settle()

  const { text } = await $.command.run(COMMAND)
  expect(text).toBe(
    [
      'Mac: busy',
      'CPU ▲ 92% of 10 cores · load 14.0, 5.0, 5.0 over 1, 5 and 15 minutes',
      'Memory 56% in use of 16 GB · pressure normal · swap 1.5 GB of 3 GB in use',
      'Simulators booted: 1 (iPhone 17 Pro on iOS 27.0)',
      '',
      'Busiest now',
      '• Xcode: 8 cores (swift-frontend ×8)',
      '• Claude: 0.6 cores (Claude Helper (Renderer))',
      '• macOS: 0.4 cores (WindowServer)',
      '',
      'Most memory',
      '• Claude: 1.2 GB',
      '• macOS: 760 MB',
      '• Simulator: 12 MB',
      '',
      'Shut down every simulator: xcrun simctl shutdown all',
    ].join('\n'),
  )
})

test('/mac-load says when there is nothing to read', async ($, on) => {
  const { clock } = engine(on, { ...calm(), missing: Object.keys(PROGRAMS) })
  await $.session.start(START)
  await clock.settle()

  expect((await $.command.run(COMMAND)).text).toBe('Nothing to read here: mac-load needs macOS.')
})

test("shows another chat's fresh reading rather than reading the Mac again", async ($, on) => {
  const world = calm()
  const { stored, programs, status, clock } = engine(on, world)
  await $.session.start(START)
  await clock.settle()
  expect(stored.reading).toMatchObject({ at: NOW, cpu: 28 })

  // Another chat read the Mac 10 seconds before this chat's next turn came round.
  stored.reading = { ...(stored.reading as object), at: NOW + 20_000, cpu: 61 }
  const before = programs().length
  await clock.advance(30_000)
  expect(programs().length).toBe(before)
  expect(status.at(-1)).toBe('CPU 61% · Memory 56% · 1 sim')

  // Once nobody has read it for 25 seconds, this chat reads it itself.
  await clock.advance(30_000)
  expect(programs().length).toBe(before + 3)
})

test('falls back on the processes for the CPU when iostat does not answer', async ($, on) => {
  const { status, clock } = engine(on, { ...calm(), iostat: undefined })
  await $.session.start(START)
  await clock.settle()

  // WindowServer 40% and Claude 60% of one core each, over 10 cores.
  expect(status.at(-1)).toBe('CPU 10% · Memory 56% · 1 sim')
})

test('counts a simulator\'s pathless children as Simulator', async ($, on) => {
  const children = ps([[44001, 0, LAUNCHD_SIM], [44100, 290, 'assetsd', 44001], [601, 40, WINDOW_SERVER]])
  const { status, clock } = engine(on, { ...calm(), iostat: iostat(88), ps: children })
  await $.session.start(START)
  await clock.settle()

  expect(status.at(-1)).toBe('CPU ▲ 88% · Memory 56% · Simulator using 3 cores')
})

test('lets /mac-load run while a turn is still going', async ($, on) => {
  const { commands, clock } = engine(on, calm())
  await $.session.start(START)
  await clock.settle()

  expect(commands).toEqual([{ name: 'mac-load', immediate: true }])
})

test('draws its line afresh after a /clear', async ($, on) => {
  const { status, clock } = engine(on, calm())
  await $.session.start(START)
  await clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 'one', resume: { id: 'one' } })
  await clock.advance(30_000)

  expect(status).toEqual(['CPU 28% · Memory 56% · 1 sim', 'CPU 28% · Memory 56% · 1 sim'])
})
