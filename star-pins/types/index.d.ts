// null until the first read, and for good where there is no desktop sidebar
// (a terminal or cloud session): the footer is then left as it was.
export type PinState = boolean | null

declare module 'claude-code' {
  interface PluginState {
    'star-pins': {
      pinned: PinState
      // A pin change is in flight; presses wait for it.
      busy: boolean
    }
  }
}
