// Token counts of one model and source in one hour: requests, input, cache write, cache read, output.
export type Counts = [number, number, number, number, number]

// One hour's counts by "<model>|<source>", the source being `main` or `agents`.
export type Hour = Record<string, Counts>

// Hours by the hour's start in milliseconds, as a string key.
export type Hours = Record<string, Hour>

// What one chat saves under `session:<id>` in the mod's store.
export type Session = { project: string; updatedAt: number; hours: Hours }

// One bar of the report: a model, a source or a project, with its tokens and share of the window's.
export type Row = { label: string; tokens: number; share: number }

// One window of the report, such as the last 5 hours.
export type Section = {
  title: string
  tokens: number
  requests: number
  models: Row[]
  sources: Row[]
  projects: Row[]
}

export type Report = { at: number; sections: Section[] }

declare module 'claude-code' {
  interface PluginState {
    'UsageBreakdown': {
      // The chat the counts below belong to; '' before the first request.
      sessionId: string
      // The basename of the chat's git top level, or of its working folder.
      project: string
      // This chat's counts, the same as its saved value.
      hours: Hours
      // How many requests were recorded, and how many of those the last save held.
      changes: number
      saved: number
      // When the chat last saved and when old chats were last swept, in milliseconds.
      savedAt: number
      sweptAt: number
      // What the pane shows; `at` is 0 until the first refresh.
      report: Report
    }
  }
}
