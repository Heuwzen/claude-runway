import { expect, test } from 'claude-code/testing'

import type { App, Levels, Reading } from '../types'
import {
  appOf,
  appsOf,
  cpuLevelOf,
  culpritOf,
  detailsOf,
  formatBytes,
  formatCores,
  keepTop,
  levelsOf,
  memoryLevelOf,
  parseIostat,
  cpuOf,
  isReading,
  parsePs,
  parseSimulators,
  parseSysctl,
  parseTop,
  runtimeName,
  simulatorsOf,
  statusOf,
  toastOf,
  worstOf,
} from './format'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const CALM: Levels = { cpu: 'normal', memory: 'normal', simulators: 'normal' }

const app = (name: string, cores: number, bytes?: number): App => ({
  name,
  cores,
  ...(bytes === undefined ? {} : { bytes }),
  processes: [{ name, count: 1, cores }],
})

const reading = (patch: Partial<Reading> = {}): Reading => ({
  at: NOW,
  cpu: 28,
  cores: 10,
  load: [3, 3, 3],
  memory: 56,
  pressure: 'normal',
  simulators: 0,
  apps: [app('Claude', 0.6, 1.2 * 1024 ** 3), app('macOS', 0.4, 0.7 * 1024 ** 3)],
  ...patch,
})

test('reads how busy the cores were from the second iostat row, never the first', async () => {
  const header = '      cpu    load average\n us sy id   1m   5m   15m\n'
  expect(parseIostat(`${header} 21 10 68  4.15 7.04 14.77\n 14  6 80  4.15 7.04 14.77\n`)).toBe(20)
  expect(parseIostat(`${header} 21 10 68  4.15 7.04 14.77\n`)).toBe(undefined)
  expect(parseIostat('')).toBe(undefined)
  expect(parseIostat('iostat: illegal option')).toBe(undefined)
})

test('reads the cores, memory, pressure, load and swap, whichever this Mac has', async () => {
  const text = [
    'hw.logicalcpu: 10',
    'hw.memsize: 17179869184',
    'kern.memorystatus_level: 40',
    'kern.memorystatus_vm_pressure_level: 2',
    'vm.loadavg: { 4.38 8.08 15.92 }',
    'vm.swapusage: total = 3072.00M  used = 1586.19M  free = 1485.81M  (encrypted)',
  ].join('\n')
  expect(parseSysctl(text)).toEqual({
    cores: 10,
    ramBytes: 17179869184,
    memory: 60,
    pressure: 'warning',
    load: [4.38, 8.08, 15.92],
    swap: { usedBytes: 1586.19 * 1024 ** 2, totalBytes: 3072 * 1024 ** 2 },
  })
  expect(parseSysctl('hw.logicalcpu: 8\nsysctl: unknown oid')).toEqual({ cores: 8 })
  expect(parseSysctl('vm.loadavg: { 212,40 90,10 55,00 }').load).toEqual([212.4, 90.1, 55])
  expect(parseSysctl('hw.logicalcpu: 0\nkern.memorystatus_level: \nkern.memorystatus_vm_pressure_level: 3')).toEqual({})
})

test('reads ps rows, names with spaces included', async () => {
  const text = '    1     0   0.6 /sbin/launchd\n91104     1  19,2 /Applications/Claude.app/Contents/MacOS/Claude Helper (Renderer)  \n  739     1   0.0 Core Audio Driver (X.driver)\n 5120   739   1.0 /Applications/Café 日本.app/Contents/MacOS/Café\n'
  expect(parsePs(text)).toEqual([
    { pid: 1, ppid: 0, cpu: 0.6, command: '/sbin/launchd' },
    { pid: 91104, ppid: 1, cpu: 19.2, command: '/Applications/Claude.app/Contents/MacOS/Claude Helper (Renderer)' },
    { pid: 739, ppid: 1, cpu: 0, command: 'Core Audio Driver (X.driver)' },
    { pid: 5120, ppid: 739, cpu: 1, command: '/Applications/Café 日本.app/Contents/MacOS/Café' },
  ])
})

test("sums the processes' own figures for the CPU when iostat gives none", async () => {
  const processes = [
    { pid: 1, ppid: 0, cpu: 250, command: '/x' },
    { pid: 2, ppid: 1, cpu: 50, command: '/y' },
  ]
  expect(cpuOf(processes, 10)).toBe(30)
  expect(cpuOf([{ pid: 1, ppid: 0, cpu: 2400, command: '/x' }], 10)).toBe(100)
  expect(cpuOf([], 10)).toBe(undefined)
})

test("reads each process's memory footprint from top", async () => {
  const text = 'Processes: 828 total\nPhysMem: 15G used\n\nPID    MEM  \n91104  1272M+\n601    761M \n42254  2368K-\n7      1.5G\n'
  expect([...parseTop(text)]).toEqual([
    [91104, 1272 * 1024 ** 2],
    [601, 761 * 1024 ** 2],
    [42254, 2368 * 1024],
    [7, 1.5 * 1024 ** 3],
  ])
})

test('puts each process with its app', async () => {
  const runtime = '/Library/Developer/CoreSimulator/Volumes/iOS_24A5380i/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.0.simruntime/Contents/Resources/RuntimeRoot'
  const cases: [string, string][] = [
    ['/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)', 'Claude'],
    ['/Users/me/Library/Application Support/Claude/claude-code/2.1.289/ee67e3f1ea60/claude.app/Contents/MacOS/claude', 'Claude'],
    ['/Users/me/.local/bin/claude', 'Claude'],
    [`${runtime}/System/Library/PrivateFrameworks/PosterBoard.framework/PlugIns/EmojiPosterExtension.appex/EmojiPosterExtension`, 'Simulator'],
    ['/Users/me/Library/Developer/CoreSimulator/Devices/ABC/data/Containers/Bundle/Application/DEF/NoteOS.app/NoteOS', 'Simulator'],
    ['/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator', 'Simulator'],
    ['/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/XPCServices/SimLaunchHost.arm64.xpc/Contents/MacOS/SimLaunchHost', 'Simulator'],
    ['launchd_sim', 'Simulator'],
    ['/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend', 'Xcode'],
    ['/Applications/Xcode-beta.app/Contents/Developer/usr/bin/xcodebuild', 'Xcode'],
    ['/Library/Developer/Toolchains/swift-6.2-RELEASE.xctoolchain/usr/bin/swift-frontend', 'Xcode'],
    ['/Library/Developer/CommandLineTools/usr/bin/clang', 'Xcode'],
    ['/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/ld', 'Xcode'],
    ['/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent', 'Web pages'],
    ['/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine', 'Virtual machine'],
    // Xcode itself and its builds count as Xcode; other tools that ship inside it do not.
    ['/Applications/Xcode.app/Contents/MacOS/Xcode', 'Xcode'],
    ['/Applications/Xcode.app/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/PlugIns/SWBBuildService.bundle/Contents/MacOS/SWBBuildService', 'Xcode'],
    ['/Applications/Xcode.app/Contents/SharedFrameworks/SourceKit.framework/Versions/A/XPCServices/SourceKitService.xpc/Contents/MacOS/SourceKitService', 'Xcode'],
    ['/Applications/Xcode-beta.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python', 'Python'],
    ['/Applications/Xcode-beta.app/Contents/Developer/usr/bin/git', 'git'],
    ['/Library/Developer/CommandLineTools/usr/bin/make', 'make'],
    ['/usr/local/bin/node', 'node'],
    ['/usr/local/Cellar/ollama/0.9.0/bin/ollama', 'ollama'],
    ['/Applications/iTerm.app/Contents/MacOS/iTerm2', 'iTerm'],
    ['/Applications/Café 日本.app/Contents/MacOS/Café', 'Café 日本'],
    ['/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow', 'macOS'],
    ['/Applications/Brave Browser.app/Contents/Frameworks/Brave Browser Framework.framework/Helpers/Brave Browser Helper.app/Contents/MacOS/Brave Browser Helper', 'Brave Browser'],
    ['/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder', 'Finder'],
    ['/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer', 'macOS'],
    ['/usr/libexec/diagnosticd', 'macOS'],
    ['/sbin/launchd', 'macOS'],
    ['/opt/homebrew/Cellar/node/24.1.0/bin/node', 'node'],
    ['automountd', 'automountd'],
  ]

  for (const [command, name] of cases) {
    expect([command, appOf(command)]).toEqual([command, name])
  }
})

test("adds up each app's processes, busiest first, naming its busiest two", async () => {
  const runtime = '/Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot'
  const apps = appsOf(
    [
      { pid: 1, ppid: 0, cpu: 75, command: '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer' },
      { pid: 2, ppid: 1, cpu: 50, command: `${runtime}/EmojiPosterExtension` },
      { pid: 3, ppid: 1, cpu: 50, command: `${runtime}/EmojiPosterExtension` },
      { pid: 4, ppid: 1, cpu: 25, command: `${runtime}/KaleidoscopePoster` },
      { pid: 5, ppid: 1, cpu: 0, command: `${runtime}/sbin/launchd_sim` },
    ],
    new Map([[1, 800], [2, 100]]),
  )

  expect(apps).toEqual([
    {
      name: 'Simulator',
      cores: 1.25,
      bytes: 100,
      processes: [{ name: 'EmojiPosterExtension', count: 2, cores: 1 }, { name: 'KaleidoscopePoster', count: 1, cores: 0.25 }],
    },
    { name: 'macOS', cores: 0.75, bytes: 800, processes: [{ name: 'WindowServer', count: 1, cores: 0.75 }] },
  ])
  expect(appsOf([{ pid: 1, ppid: 0, cpu: 40, command: '/sbin/launchd' }])[0]?.bytes).toBe(undefined)
  expect(simulatorsOf([{ pid: 5, ppid: 1, cpu: 1, command: '/x/sbin/launchd_sim' }, { pid: 6, ppid: 1, cpu: 0, command: 'launchd_sim' }])).toBe(2)
  // A simulator's children count as Simulator even without a path.
  const children = appsOf([
    { pid: 5, ppid: 1, cpu: 0, command: '/x/sbin/launchd_sim' },
    { pid: 7, ppid: 5, cpu: 300, command: 'assetsd' },
    { pid: 8, ppid: 1, cpu: 50, command: 'assetsd' },
  ])
  expect(children.map(found => [found.name, found.cores])).toEqual([['Simulator', 3], ['assetsd', 0.5]])
})

test('keeps the busiest apps and the largest, in order of how busy', async () => {
  const apps = [app('A', 5, 1), app('B', 4, 9), app('C', 3, 2), app('D', 2, 8)]
  expect(keepTop(apps, 1).map(kept => kept.name)).toEqual(['A', 'B'])
  expect(keepTop(apps, 2).map(kept => kept.name)).toEqual(['A', 'B', 'D'])
})

test('calls the CPU busy from 85%, and holds it down to 70%', async () => {
  expect(cpuLevelOf(reading({ cpu: 84 }), 'normal')).toBe('normal')
  expect(cpuLevelOf(reading({ cpu: 85 }), 'normal')).toBe('busy')
  expect(cpuLevelOf(reading({ cpu: 70 }), 'busy')).toBe('busy')
  expect(cpuLevelOf(reading({ cpu: 69 }), 'busy')).toBe('normal')
})

test('calls the CPU overloaded only with work queueing for the cores', async () => {
  // One build keeps every core busy without a queue.
  expect(cpuLevelOf(reading({ cpu: 100, load: [18, 9, 5] }), 'normal')).toBe('busy')
  expect(cpuLevelOf(reading({ cpu: 100, load: [30, 9, 5] }), 'normal')).toBe('overloaded')
  expect(cpuLevelOf(reading({ cpu: 89, load: [40, 9, 5] }), 'normal')).toBe('busy')
  // macOS's load lags behind: a high one over idle cores is not an overload.
  expect(cpuLevelOf(reading({ cpu: 31, load: [27, 30, 27] }), 'normal')).toBe('normal')
  expect(cpuLevelOf(reading({ cpu: 75, load: [20, 9, 5] }), 'overloaded')).toBe('overloaded')
  expect(cpuLevelOf(reading({ cpu: 75, load: [19, 9, 5] }), 'overloaded')).toBe('busy')
  expect(cpuLevelOf(reading({ cpu: 100, load: undefined }), 'normal')).toBe('busy')
})

test("follows macOS's memory pressure, and the share in use where macOS gives none", async () => {
  expect(memoryLevelOf({ memory: 99, pressure: 'normal' })).toBe('normal')
  expect(memoryLevelOf({ memory: 60, pressure: 'warning' })).toBe('busy')
  expect(memoryLevelOf({ memory: 90, pressure: 'critical' })).toBe('overloaded')
  expect([84, 85, 92].map(memory => memoryLevelOf({ memory }))).toEqual(['normal', 'busy', 'overloaded'])
  expect(memoryLevelOf({})).toBe('normal')
})

test('marks three booted simulators busy, and takes the worst level as the whole', async () => {
  expect(levelsOf(reading({ simulators: 3 }), CALM)).toEqual({ cpu: 'normal', memory: 'normal', simulators: 'busy' })
  expect(worstOf({ cpu: 'busy', memory: 'overloaded', simulators: 'normal' })).toBe('overloaded')
  expect(worstOf(CALM)).toBe('normal')
})

test('writes cores and sizes the way Activity Monitor readers expect', async () => {
  expect([0.56, 1, 1.04, 1.4, 2, 3.12, 8].map(formatCores)).toEqual(['0.6 cores', '1 core', '1 core', '1.4 cores', '2 cores', '3 cores', '8 cores'])
  expect([700 * 1024 ** 2, 1.2 * 1024 ** 3, 16 * 1024 ** 3].map(formatBytes)).toEqual(['700 MB', '1.2 GB', '16 GB'])
})

test('names the app behind the worst strain, and none when nothing stands out', async () => {
  const busy = reading({ apps: [app('Xcode', 7.9, 1024 ** 3), app('Claude', 0.6, 2 * 1024 ** 3)] })
  expect(culpritOf(busy, { ...CALM, cpu: 'busy' })?.text).toBe('Xcode using 8 cores')
  expect(culpritOf(busy, { ...CALM, memory: 'busy' })?.text).toBe('Claude using 2 GB')
  expect(culpritOf(busy, { ...CALM, cpu: 'busy', memory: 'overloaded' })?.text).toBe('Claude using 2 GB')
  expect(culpritOf(busy, CALM)).toBe(undefined)
  expect(culpritOf(reading({ apps: [app('macOS', 0.3)] }), { ...CALM, cpu: 'busy' })).toBe(undefined)
  // 0.6 cores is too small a share of 9.5 busy cores to blame; the kernel, which ps never lists, may hold the rest.
  expect(culpritOf(reading({ cpu: 95, apps: [app('Brave Browser', 0.6)] }), { ...CALM, cpu: 'busy' })).toBe(undefined)
  expect(culpritOf(reading({ cpu: 95, apps: [app('Brave Browser', 2.4)] }), { ...CALM, cpu: 'busy' })?.text).toBe('Brave Browser using 2 cores')
  expect(culpritOf(reading({ apps: [app('Xcode', 4)] }), { ...CALM, memory: 'busy' })).toBe(undefined)
  // When no app stands out for the worse strain, the other strain's app is named.
  expect(culpritOf(reading({ apps: [app('macOS', 0.3, 2 * 1024 ** 3)] }), { ...CALM, cpu: 'busy', memory: 'busy' })?.text).toBe('macOS using 2 GB')
})

test('writes the status line: each strain marked, the culprit, and the age once stale', async () => {
  expect(statusOf(reading(), CALM, NOW)).toBe('CPU 28% · Memory 56%')
  expect(statusOf(reading({ simulators: 1 }), CALM, NOW)).toBe('CPU 28% · Memory 56% · 1 sim')
  expect(statusOf(reading({ cpu: 100, simulators: 1, apps: [app('Simulator', 3.1)] }), { ...CALM, cpu: 'overloaded' }, NOW)).toBe(
    'CPU ◆ 100% · Memory 56% · Simulator using 3 cores',
  )
  expect(statusOf(reading({ simulators: 4 }), { ...CALM, simulators: 'busy' }, NOW)).toBe('CPU 28% · Memory 56% · ▲ 4 sims')
  expect(statusOf(reading({ memory: undefined }), CALM, NOW)).toBe('CPU 28%')
  expect(statusOf(reading(), CALM, NOW + 74_000)).toBe('CPU 28% · Memory 56%')
  expect(statusOf(reading(), CALM, NOW + 75_000)).toBe('CPU 28% · Memory 56% · as of 1m ago')
  expect(statusOf(reading(), CALM, NOW + 2 * 3_600_000)).toBe('CPU 28% · Memory 56% · as of 2h ago')
})

test('toasts only an overload, with advice where it helps', async () => {
  const sims = reading({ cpu: 100, apps: [app('Simulator', 3.1)] })
  expect(toastOf(sims, { ...CALM, cpu: 'busy' })).toBe(undefined)
  expect(toastOf(sims, { ...CALM, cpu: 'overloaded' })).toBe('Mac is overloaded: CPU at 100%, Simulator using 3 cores. Shut down simulators you are not using.')
  expect(toastOf(reading({ cpu: 97, apps: [app('Xcode', 9.4)] }), { ...CALM, cpu: 'overloaded' })).toBe(
    'Mac is overloaded: CPU at 97%, Xcode using 9 cores. Run fewer builds at once.',
  )
  expect(toastOf(reading({ cpu: 100, apps: [app('Claude', 0.4, 3 * 1024 ** 3)] }), { cpu: 'overloaded', memory: 'overloaded', simulators: 'normal' })).toBe(
    'Mac is overloaded: CPU at 100% and memory nearly full, Claude using 3 GB.',
  )
})

test('names simulator runtimes and reads the booted devices', async () => {
  expect(runtimeName('com.apple.CoreSimulator.SimRuntime.iOS-26-0')).toBe('iOS 26.0')
  expect(runtimeName('com.apple.CoreSimulator.SimRuntime.watchOS-11-2')).toBe('watchOS 11.2')
  const text = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [{ name: 'iPhone 17 Pro', state: 'Booted' }, { name: 'iPad', state: 'Shutdown' }],
      broken: 'x',
    },
  })
  expect(parseSimulators(text)).toEqual([{ name: 'iPhone 17 Pro', runtime: 'iOS 27.0' }])
  expect(parseSimulators('not json')).toEqual([])
  expect(parseSimulators('null')).toEqual([])
})

test('takes back from the store only a reading this version wrote', async () => {
  expect(isReading(reading())).toBe(true)
  expect(isReading({ load: [3, 3, 3], cores: 10, memoryFree: 40, simulators: [] })).toBe(false)
  expect(isReading({ ...reading(), apps: [{ name: 'X' }] })).toBe(false)
  expect(isReading(null)).toBe(false)
})

test('/mac-load says how many booted simulators simctl could not name', async () => {
  const text = detailsOf(reading({ simulators: 2 }), CALM, [{ name: 'iPhone 17 Pro', runtime: 'iOS 27.0' }])
  expect(text).toContain('Simulators booted: 2 (iPhone 17 Pro on iOS 27.0, 1 more)')
  expect(detailsOf(reading({ simulators: 1 }), CALM, [])).toContain('Simulators booted: 1\n')
})
