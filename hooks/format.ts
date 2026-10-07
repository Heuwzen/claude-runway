import type { App, Level, Levels, Pressure, Reading, Simulator } from '../types'

// The CPU is busy from `enter` percent of all cores and stays so until it falls under
// `stay`. Overloaded also needs the load to show work queueing for the cores: `load`
// times their number to enter, `loadStay` times to stay. A single build keeps every core
// busy without that queue; parallel builds or a runaway simulator build one.
export const CPU_BUSY = { enter: 85, stay: 70 }
export const CPU_OVERLOADED = { enter: 90, stay: 75, load: 3, loadStay: 2 }
export const SIMULATORS_BUSY = 3
// Only for a Mac that does not give its memory pressure: the share of memory in use.
export const MEMORY_BUSY = 85
export const MEMORY_OVERLOADED = 92

// A reading older than this is shown with its age: the Mac has not answered in time since.
export const STALE_AFTER = 75_000
// One toast per overload: this chat says nothing again for this long.
export const TOAST_COOLDOWN = 10 * 60_000

// What one `sysctl` reads: the cores, the memory, macOS's memory pressure, the load, the swap.
export const SYSCTL_NAMES = [
  'hw.logicalcpu',
  'hw.memsize',
  'kern.memorystatus_level',
  'kern.memorystatus_vm_pressure_level',
  'vm.loadavg',
  'vm.swapusage',
]

const NUMBER = /^\d+(?:[.,]\d+)?$/
const UNITS: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }
const PRESSURES: Record<string, Pressure> = { '1': 'normal', '2': 'warning', '4': 'critical' }

const number = (text: string) => (NUMBER.test(text) ? Number(text.replace(',', '.')) : NaN)
const basename = (command: string) => command.slice(command.lastIndexOf('/') + 1)
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

// "1586.19M", as sysctl and top write sizes.
function bytesOf(text: string) {
  const match = /^(\d+(?:[.,]\d+)?)([BKMGT])$/.exec(text)
  const unit = UNITS[match?.[2] ?? '']

  return match === null || unit === undefined ? undefined : number(match[1] ?? '') * unit
}

// `iostat -n0 -c 2 -w 2` writes a row since boot, then one for the last two seconds:
// user, system and idle, then the load. How busy the cores were over those seconds.
export function parseIostat(text: string) {
  const rows = text
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(fields => fields.length >= 3 && fields.slice(0, 3).every(field => NUMBER.test(field)))
  const idle = number(rows.at(-1)?.[2] ?? '')

  // A lone row counts from boot, which says nothing about now.
  return rows.length < 2 || !(idle <= 100) ? undefined : 100 - idle
}

export type System = Omit<Reading, 'at' | 'cpu' | 'cores' | 'simulators' | 'apps'> & { cores?: number }

// `sysctl` with SYSCTL_NAMES writes "name: value" for each this Mac has.
export function parseSysctl(text: string): System {
  const values = new Map<string, string>()

  for (const line of text.split('\n')) {
    const at = line.indexOf(':')

    if (at > 0) {
      values.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
    }
  }

  const system: System = {}
  const cores = number(values.get('hw.logicalcpu') ?? '')
  const ram = number(values.get('hw.memsize') ?? '')
  const available = number(values.get('kern.memorystatus_level') ?? '')
  const pressure = PRESSURES[values.get('kern.memorystatus_vm_pressure_level') ?? '']
  const load = /^\{\s*(\S+)\s+(\S+)\s+(\S+)\s*\}$/.exec(values.get('vm.loadavg') ?? '')
  const swap = /total = (\S+)\s+used = (\S+)/.exec(values.get('vm.swapusage') ?? '')

  if (Number.isInteger(cores) && cores > 0) {
    system.cores = cores
  }

  if (ram > 0) {
    system.ramBytes = ram
  }

  if (available >= 0 && available <= 100) {
    system.memory = 100 - available
  }

  if (pressure !== undefined) {
    system.pressure = pressure
  }

  if (load !== null) {
    const averages = [number(load[1] ?? ''), number(load[2] ?? ''), number(load[3] ?? '')] as [number, number, number]

    if (averages.every(Number.isFinite)) {
      system.load = averages
    }
  }

  const totalBytes = bytesOf(swap?.[1] ?? '')
  const usedBytes = bytesOf(swap?.[2] ?? '')

  if (totalBytes !== undefined && usedBytes !== undefined && totalBytes > 0) {
    system.swap = { usedBytes, totalBytes }
  }

  return system
}

// One process: the share of one core it keeps busy, and its executable, by full path
// where macOS gives one.
export type Process = { pid: number; cpu: number; command: string }

// `ps -A -o pid=,pcpu=,comm=`.
export function parsePs(text: string): Process[] {
  const processes: Process[] = []

  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+(?:[.,]\d+)?)\s+(\S.*?)\s*$/.exec(line)

    if (match !== null) {
      processes.push({ pid: Number(match[1]), cpu: number(match[2] ?? ''), command: match[3] ?? '' })
    }
  }

  return processes
}

// `top -l 1 -o mem -n 100 -stats pid,mem`: the memory footprint of each process listed,
// the figure Activity Monitor shows, by process id.
export function parseTop(text: string) {
  const footprints = new Map<number, number>()

  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+?)[+-]?\s*$/.exec(line)
    const bytes = bytesOf(match?.[2] ?? '')

    if (match !== null && bytes !== undefined) {
      footprints.set(Number(match[1]), bytes)
    }
  }

  return footprints
}

// The app a process belongs to, by where its executable lives: the simulators and Xcode's
// tools first, then the outermost .app bundle, then macOS's own folders.
export function appOf(command: string) {
  const name = basename(command)

  if (command.includes('/CoreSimulator') || command.includes('/Simulator.app/') || name === 'launchd_sim') {
    return 'Simulator'
  }

  if (/\/Xcode[^/]*\.app\//.test(command) || command.includes('.xctoolchain/') || command.startsWith('/Library/Developer/CommandLineTools/')) {
    return 'Xcode'
  }

  // WebKit's own processes draw and run web pages, Safari's above all.
  if (command.includes('/com.apple.WebKit.')) {
    return 'Safari'
  }

  const bundle = /\/([^/]+)\.app\//.exec(command)

  if (bundle !== null) {
    return capitalize(bundle[1] ?? name)
  }

  // Claude Code in a terminal, installed outside any app.
  if (name === 'claude') {
    return 'Claude'
  }

  return /^\/(?:System|usr|bin|sbin|Library\/Apple)\//.test(command) ? 'macOS' : name
}

export const simulatorsOf = (processes: readonly Process[]) =>
  processes.filter(process => basename(process.command) === 'launchd_sim').length

// Each app's processes together, busiest first, with the busiest two of them by name.
// Memory is added up only from `footprints`, when it was read.
export function appsOf(processes: readonly Process[], footprints?: ReadonlyMap<number, number>): App[] {
  type Tally = { cores: number; bytes: number; processes: Map<string, { count: number; cores: number }> }
  const tallies = new Map<string, Tally>()

  for (const process of processes) {
    const name = appOf(process.command)
    const tally = tallies.get(name) ?? { cores: 0, bytes: 0, processes: new Map() }
    const own = tally.processes.get(basename(process.command)) ?? { count: 0, cores: 0 }
    const cores = Number.isFinite(process.cpu) ? process.cpu / 100 : 0

    own.count += 1
    own.cores += cores
    tally.processes.set(basename(process.command), own)
    tally.cores += cores
    tally.bytes += footprints?.get(process.pid) ?? 0
    tallies.set(name, tally)
  }

  return [...tallies]
    .map(([name, tally]) => ({
      name,
      cores: tally.cores,
      ...(footprints === undefined ? {} : { bytes: tally.bytes }),
      processes: [...tally.processes]
        .map(([process, own]) => ({ name: process, ...own }))
        .sort((a, b) => b.cores - a.cores)
        .slice(0, 2),
    }))
    .sort((a, b) => b.cores - a.cores)
}

const byBytes = (a: App, b: App) => (b.bytes ?? 0) - (a.bytes ?? 0)

// The `count` busiest apps and the `count` largest: all a reading needs to keep.
export function keepTop(apps: readonly App[], count = 8) {
  const kept = new Set([...apps.slice(0, count), ...[...apps].sort(byBytes).slice(0, count)])

  return apps.filter(app => kept.has(app))
}

const RANKS: Record<Level, number> = { normal: 0, busy: 1, overloaded: 2 }

export const worstOf = (levels: Levels): Level =>
  [levels.cpu, levels.memory, levels.simulators].reduce((worst, level) => (RANKS[level] > RANKS[worst] ? level : worst))

// Where the CPU stands, given where it stood: a level is left only with margin to spare.
export function cpuLevelOf(reading: Reading, previous: Level): Level {
  const load = reading.load?.[0]
  const queues = (times: number) => load !== undefined && load >= times * reading.cores

  if (
    (reading.cpu >= CPU_OVERLOADED.enter && queues(CPU_OVERLOADED.load))
    || (previous === 'overloaded' && reading.cpu >= CPU_OVERLOADED.stay && queues(CPU_OVERLOADED.loadStay))
  ) {
    return 'overloaded'
  }

  return reading.cpu >= CPU_BUSY.enter || (previous !== 'normal' && reading.cpu >= CPU_BUSY.stay) ? 'busy' : 'normal'
}

// macOS's memory pressure, which has margins of its own; the share in use where it gives none.
export function memoryLevelOf(reading: Pick<Reading, 'memory' | 'pressure'>): Level {
  if (reading.pressure !== undefined) {
    return reading.pressure === 'critical' ? 'overloaded' : reading.pressure === 'warning' ? 'busy' : 'normal'
  }

  if (reading.memory === undefined) {
    return 'normal'
  }

  return reading.memory >= MEMORY_OVERLOADED ? 'overloaded' : reading.memory >= MEMORY_BUSY ? 'busy' : 'normal'
}

export const levelsOf = (reading: Reading, previous: Levels): Levels => ({
  cpu: cpuLevelOf(reading, previous.cpu),
  memory: memoryLevelOf(reading),
  simulators: reading.simulators >= SIMULATORS_BUSY ? 'busy' : 'normal',
})

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

// "3 cores", "1.4 cores", "1 core".
export function formatCores(cores: number) {
  const rounded = cores >= 2 ? Math.round(cores) : Math.round(cores * 10) / 10

  return `${rounded} ${rounded === 1 ? 'core' : 'cores'}`
}

// "2.6 GB", "16 GB", "700 MB".
export function formatBytes(bytes: number) {
  if (bytes < 1024 ** 3) {
    return `${Math.round(bytes / 1024 ** 2)} MB`
  }

  return `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB`
}

function formatAge(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000))

  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

// The app behind the worst strain: the busiest by CPU when the CPU is at least as strained
// as memory, else the largest by memory, falling back on the other strain's app when none
// stands out. None while nothing is strained.
export function culpritOf(reading: Reading, levels: Levels) {
  const cpu = RANKS[levels.cpu]
  const memory = RANKS[levels.memory]
  const busiest = reading.apps[0]
  const largest = [...reading.apps].sort(byBytes)[0]
  const byCpu = cpu === 0 || busiest === undefined || busiest.cores < 0.5
    ? undefined
    : { name: busiest.name, text: `${busiest.name} using ${formatCores(busiest.cores)}` }
  const byMemory = memory === 0 || largest?.bytes === undefined || largest.bytes === 0
    ? undefined
    : { name: largest.name, text: `${largest.name} using ${formatBytes(largest.bytes)}` }

  return cpu >= memory ? byCpu ?? byMemory : byMemory ?? byCpu
}

const MARKS: Record<Level, string> = { normal: '', busy: '▲ ', overloaded: '◆ ' }

// "CPU ▲ 92% · Memory 56% · Xcode using 8 cores": each strained part marked as the rate
// limits band marks its windows, then the app behind the worst strain.
export function statusOf(reading: Reading, levels: Levels, now: number) {
  const culprit = culpritOf(reading, levels)
  const parts = [`CPU ${MARKS[levels.cpu]}${Math.round(reading.cpu)}%`]

  if (reading.memory !== undefined) {
    parts.push(`Memory ${MARKS[levels.memory]}${Math.round(reading.memory)}%`)
  }

  // The app behind a strain says more than a count of simulators, unless they are the strain.
  if (reading.simulators > 0 && (culprit === undefined || levels.simulators !== 'normal')) {
    parts.push(`${MARKS[levels.simulators]}${plural(reading.simulators, 'sim')}`)
  }

  if (culprit !== undefined) {
    parts.push(culprit.text)
  }

  if (now - reading.at >= STALE_AFTER) {
    parts.push(`as of ${formatAge(now - reading.at)} ago`)
  }

  return parts.join(' · ')
}

const ADVICE: Record<string, string> = {
  Simulator: 'Shut down simulators you are not using.',
  Xcode: 'Run fewer builds at once.',
}

// What to say as the Mac becomes overloaded: what is strained, the app behind it, and
// what would help. Nothing while it is not overloaded.
export function toastOf(reading: Reading, levels: Levels) {
  const strains = [
    ...(levels.cpu === 'overloaded' ? [`CPU at ${Math.round(reading.cpu)}%`] : []),
    ...(levels.memory === 'overloaded' ? ['memory nearly full'] : []),
  ]

  if (strains.length === 0) {
    return undefined
  }

  const culprit = culpritOf(reading, levels)
  const advice = culprit === undefined ? undefined : ADVICE[culprit.name]

  return `Mac is overloaded: ${strains.join(' and ')}${culprit === undefined ? '' : `, ${culprit.text}`}.${advice === undefined ? '' : ` ${advice}`}`
}

// "com.apple.CoreSimulator.SimRuntime.iOS-26-0" reads as "iOS 26.0".
export function runtimeName(key: string) {
  const name = key.slice(key.lastIndexOf('.') + 1)
  const [platform, ...version] = name.split('-')

  return version.length > 0 ? `${platform} ${version.join('.')}` : name
}

// The booted devices in `xcrun simctl list devices booted --json`; none for anything unreadable.
export function parseSimulators(text: string): Simulator[] {
  let parsed: unknown

  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }

  const devices = (parsed as { devices?: unknown } | null)?.devices

  if (typeof devices !== 'object' || devices === null) {
    return []
  }

  const booted: Simulator[] = []

  for (const [key, list] of Object.entries(devices)) {
    if (!Array.isArray(list)) {
      continue
    }

    for (const device of list) {
      if (device?.state === 'Booted' && typeof device.name === 'string') {
        booted.push({ name: device.name, runtime: runtimeName(key) })
      }
    }
  }

  return booted
}

const LEVEL_NAMES: Record<Level, string> = { normal: 'fine', busy: 'busy', overloaded: 'overloaded' }

const round = (value: number) => (value >= 100 ? String(Math.round(value)) : value.toFixed(1))

// "(EmojiPosterExtension ×13, KaleidoscopePoster ×7)", or nothing when the app is a lone
// process of its own name.
function processesOf(app: App) {
  const named = app.processes.filter(process => process.cores >= 0.05)
  const only = named[0]

  if (only === undefined || (named.length === 1 && only.name === app.name && only.count === 1)) {
    return ''
  }

  return ` (${named.map(process => (process.count > 1 ? `${process.name} ×${process.count}` : process.name)).join(', ')})`
}

// The answer to /mac-load: the Mac as a whole, then what is using it, by app.
export function detailsOf(reading: Reading, levels: Levels, simulators: readonly Simulator[]) {
  const load = reading.load === undefined ? '' : ` · load ${reading.load.map(round).join(', ')} over 1, 5 and 15 minutes`
  const lines = [
    `Mac: ${LEVEL_NAMES[worstOf(levels)]}`,
    `CPU ${MARKS[levels.cpu]}${Math.round(reading.cpu)}% of ${plural(reading.cores, 'core')}${load}`,
  ]

  if (reading.memory !== undefined) {
    const of = reading.ramBytes === undefined ? '' : ` of ${formatBytes(reading.ramBytes)}`
    const memory = [`Memory ${MARKS[levels.memory]}${Math.round(reading.memory)}% in use${of}`]

    if (reading.pressure !== undefined) {
      memory.push(`pressure ${reading.pressure}`)
    }

    if (reading.swap !== undefined) {
      memory.push(`swap ${formatBytes(reading.swap.usedBytes)} of ${formatBytes(reading.swap.totalBytes)} in use`)
    }

    lines.push(memory.join(' · '))
  }

  if (reading.simulators > 0) {
    const names = simulators.map(simulator => `${simulator.name} on ${simulator.runtime}`).join(', ')
    lines.push(`Simulators booted: ${MARKS[levels.simulators]}${reading.simulators}${names === '' ? '' : ` (${names})`}`)
  }

  const busiest = reading.apps.filter(app => app.cores >= 0.1).slice(0, 5)
  const largest = [...reading.apps].filter(app => (app.bytes ?? 0) > 0).sort(byBytes).slice(0, 5)

  if (busiest.length > 0) {
    lines.push('', 'Busiest now', ...busiest.map(app => `• ${app.name}: ${formatCores(app.cores)}${processesOf(app)}`))
  }

  if (largest.length > 0) {
    lines.push('', 'Most memory', ...largest.map(app => `• ${app.name}: ${formatBytes(app.bytes ?? 0)}`))
  }

  if (reading.simulators > 0) {
    lines.push('', 'Shut down every simulator: xcrun simctl shutdown all')
  }

  return lines.join('\n')
}
