// A simulator that is booted right now.
export type Simulator = { name: string; runtime: string }

// One reading of the Mac. `memoryFree` is a percentage, left out when it could not be read.
export type Reading = {
  load: [number, number, number]
  cores: number
  memoryFree?: number
  simulators: Simulator[]
}

export type Level = 'normal' | 'busy' | 'overloaded'

declare module 'claude-code' {
  interface PluginState {
    'mac-load': {
      // The latest reading, or null before the first.
      reading: Reading | null
      // Where the Mac stands now, kept between readings so a level is left only with some margin.
      level: Level
      // Set once `sysctl` fails for good: nothing is polled or shown after that.
      isStopped: boolean
      // Failed load readings in a row.
      failures: number
    }
  }
}
