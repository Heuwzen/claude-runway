import type { Level, Reading, Simulator } from '../types'

// A level is entered at `enter` times the cores, or below `memory` percent free,
// and left only well clear of both (see holds).
export const BUSY = { load: 1.5, memory: 15, simulators: 3 }
export const OVERLOADED = { load: 3, memory: 8 }
// How far below a level's load threshold, and above its memory one, the Mac must be to leave it.
export const LOAD_MARGIN = 0.8
export const MEMORY_MARGIN = 5

const number = (text: string) => Number(text.replace(',', '.'))

// "{ 3.12 2.95 2.80 }", as `sysctl -n vm.loadavg` prints it.
export function parseLoadavg(text: string): Reading['load'] | undefined {
  const match = /([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)/.exec(text)

  if (match === null) {
    return undefined
  }

  const load = [number(match[1] ?? ''), number(match[2] ?? ''), number(match[3] ?? '')] as Reading['load']

  return load.every(Number.isFinite) ? load : undefined
}

// The output of `sysctl -n hw.logicalcpu`.
export function parseCores(text: string) {
  const cores = Number.parseInt(text.trim(), 10)

  return cores > 0 ? cores : undefined
}

// `memory_pressure -Q` prints a line about the page size first, then the one we want.
export function parseMemoryFree(text: string) {
  const match = /memory free percentage:\s*(\d+(?:\.\d+)?)\s*%/i.exec(text)

  return match === null ? undefined : Number(match[1])
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

const memoryOf = (reading: Reading) => reading.memoryFree ?? 100

function enters(reading: Reading): Level {
  const [load1] = reading.load

  if (load1 >= OVERLOADED.load * reading.cores || memoryOf(reading) < OVERLOADED.memory) {
    return 'overloaded'
  }

  const isBusy = load1 >= BUSY.load * reading.cores
    || memoryOf(reading) < BUSY.memory
    || reading.simulators.length >= BUSY.simulators

  return isBusy ? 'busy' : 'normal'
}

// Whether the Mac is still too close to a level to call itself out of it.
function holds(level: 'busy' | 'overloaded', reading: Reading) {
  const [load1] = reading.load
  const limits = level === 'busy' ? BUSY : OVERLOADED
  const isClear = load1 < LOAD_MARGIN * limits.load * reading.cores
    && memoryOf(reading) >= limits.memory + MEMORY_MARGIN
    && (level === 'overloaded' || reading.simulators.length < BUSY.simulators)

  return !isClear
}

// Where the Mac stands, given where it stood: a level is left only with margin to spare.
export function levelOf(reading: Reading, previous: Level): Level {
  const entered = enters(reading)

  if (entered === 'overloaded' || (previous === 'overloaded' && holds('overloaded', reading))) {
    return 'overloaded'
  }

  if (entered === 'busy' || (previous !== 'normal' && holds('busy', reading))) {
    return 'busy'
  }

  return 'normal'
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

const MARKS: Record<Level, string> = { normal: '', busy: '▲ ', overloaded: '◆ ' }

// "▲ Mac load 6.2 / 10 cores · 23% memory free · 2 simulators"
export function statusOf(reading: Reading, level: Level) {
  const parts = [`Mac load ${reading.load[0].toFixed(1)} / ${plural(reading.cores, 'core')}`]

  if (reading.memoryFree !== undefined) {
    parts.push(`${Math.round(reading.memoryFree)}% memory free`)
  }

  if (reading.simulators.length > 0) {
    parts.push(plural(reading.simulators.length, 'simulator'))
  }

  return `${MARKS[level]}${parts.join(' · ')}`
}

// What to say on moving from `previous` to `level`, if anything: only a step up.
export function toastOf(reading: Reading, previous: Level, level: Level) {
  const load = `load ${Math.round(reading.load[0])} on ${plural(reading.cores, 'core')}`
  const memory = reading.memoryFree === undefined ? '' : `, ${Math.round(reading.memoryFree)}% memory free`

  if (level === 'overloaded' && previous !== 'overloaded') {
    return `Mac is overloaded: ${load}${memory}. Shut down simulators or pause builds.`
  }

  if (level === 'busy' && previous === 'normal') {
    const lowMemory = memoryOf(reading) < BUSY.memory ? memory : ''
    const booted = reading.simulators.length >= BUSY.simulators ? `, ${reading.simulators.length} simulators booted` : ''

    return `Mac is busy: ${load}${lowMemory}${booted}`
  }

  return undefined
}

const round = (value: number) => (value >= 100 ? Math.round(value) : value.toFixed(1))

// The answer to /mac-load.
export function detailsOf(reading: Reading, level: Level) {
  const { load, cores, memoryFree, simulators } = reading
  const lines = [
    `Mac load: ${level}`,
    `Load: ${round(load[0])} (1 min), ${round(load[1])} (5 min), ${round(load[2])} (15 min), on ${plural(cores, 'core')}`,
    `Busy from load ${Math.round(BUSY.load * cores)}, overloaded from ${Math.round(OVERLOADED.load * cores)}`,
    memoryFree === undefined ? 'Memory free: unknown' : `Memory free: ${Math.round(memoryFree)}%`,
  ]

  if (simulators.length === 0) {
    lines.push('Simulators booted: none')
  } else {
    lines.push(`Simulators booted: ${simulators.length}`)

    for (const simulator of simulators) {
      lines.push(`  ${simulator.name} (${simulator.runtime})`)
    }

    lines.push('Shut them all down: xcrun simctl shutdown all')
  }

  return lines.join('\n')
}
