// How loud the nudge is: none, a first reminder, or an overdue one.
export type Level = 0 | 1 | 2

declare module 'claude-code' {
  interface PluginState {
    'commit-nudge': {
      // The repository's top folder; null until looked up, '' when the chat's folder is not in one.
      top: string | null
      // The highest level toasted since the tree was last clean or a commit last landed; 0 before any.
      notified: Level
      // The last commit's time (seconds since the epoch, 0 for none) as of the previous measurement.
      seen: number
    }
  }
}
