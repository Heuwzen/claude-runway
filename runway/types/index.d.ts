// One rate-limit window as the engine reports it (SessionRateLimit).
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// How full this chat's context window is, from the last reply.
export type Context = { percent: number; tokens: number; window: number }

// The latest limits any chat has seen and when, kept in the mod's store so a new chat can
// show them before its own first reply.
export type Reading = { limits: Limit[]; at: number }

declare module 'claude-code' {
  interface PluginState {
    'RateLimits': {
      // This chat's context window; null until a reply reports it.
      context: Context | null
      // The windows of the reading on show.
      limits: Limit[]
      // When that reading was taken, in milliseconds since the epoch; 0 before any.
      readingAt: number
      // The time the band counts down from, moved on once a minute.
      now: number
      // The threshold each window last toasted at, so each crossing toasts once.
      toasted: Record<string, number>
    }
  }
}
