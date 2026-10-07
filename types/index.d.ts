// How strained one part of the Mac is: `busy` is marked ▲ on the status line, `overloaded` ◆.
export type Level = 'normal' | 'busy' | 'overloaded'

// Each part's level, kept between readings so a level is left only with margin to spare.
export type Levels = { cpu: Level; memory: Level; simulators: Level }

// macOS's own word on its memory, as Activity Monitor colors it: green, yellow, red.
export type Pressure = 'normal' | 'warning' | 'critical'

// One app's processes together: the cores they keep busy, their memory footprint when it
// was read, and the busiest of them by name.
export type App = {
  name: string
  cores: number
  bytes?: number
  processes: { name: string; count: number; cores: number }[]
}

// A simulator that is booted right now.
export type Simulator = { name: string; runtime: string }

// One reading of the Mac.
export type Reading = {
  // When it was taken.
  at: number
  // How busy all the cores were over the last two seconds, 0 to 100.
  cpu: number
  cores: number
  // The load over 1, 5 and 15 minutes.
  load?: [number, number, number]
  // The share of memory in use, 0 to 100: what macOS does not count as available.
  memory?: number
  pressure?: Pressure
  ramBytes?: number
  swap?: { usedBytes: number; totalBytes: number }
  simulators: number
  // The busiest apps and the largest, busiest first.
  apps: App[]
}

declare module 'claude-code' {
  interface PluginState {
    'mac-load': {
      // The latest reading, or null before the first. Shaped: a reload of code that changed
      // its idea of a reading finds the old one absent rather than misreading it.
      reading: Shaped<Reading | null>
      levels: Levels
      // Set once the mod gives up on a system it has never read: nothing is polled or shown after.
      isStopped: boolean
      // Failed readings in a row.
      failures: number
      // Whether a reading has worked on this Mac, in this chat or an earlier one.
      hasWorked: boolean
      // When this chat last toasted, so an overload that comes and goes toasts once.
      toastedAt: number
    }
  }
}
