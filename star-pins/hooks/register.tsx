import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

const pinned = atom({ plugin: 'star-pins', key: 'pinned' } as const, null)
const busy = atom({ plugin: 'star-pins', key: 'busy' } as const, false)

// The desktop app's own servers: the same calls Claude makes with its sidebar tools.
const SESSIONS = 'ccd_session_mgmt'
const SET_PINNED = 'mcp__ccd_sidebar__set_pinned'
// Catches a pin changed from the sidebar by hand while the session sits idle.
const REFRESH_MS = 10_000
// The button's address, which the ui.press hook below matches.
const PIN = 'pin'
// The state lives in the label's characters, the one thing the desktop footer
// draws (no text styles, fills or borders; primary and secondary chips look
// alike). A star in the footer's grey, outline while unpinned and filled while
// pinned (the app itself records a pinned session as starred). A flag pair drew
// too small: its font draws it so, and the footer takes no text size.
const PINNED_ICON = '★'
const UNPINNED_ICON = '☆'

async function readPinned($: EngineInterface): Promise<boolean | null> {
  try {
    const result = await $.mcp.call(SESSIONS, 'get_session', { session_id: 'self' })
    if (result.isError) return null
    const text = result.content.find(block => block.type === 'text')?.text
    if (text === undefined) return null
    const value: unknown = JSON.parse(text).pinned
    return typeof value === 'boolean' ? value : null
  } catch {
    return null
  }
}

async function refresh($: EngineInterface) {
  if (timer === undefined) {
    timer = $.clock.every(REFRESH_MS, () => void refresh($))
    // Once per load: a reload leaves the footer as the replaced module drew it
    // until something redraws it.
    $.ui.invalidate('ui.render')
  }
  const seen = presses
  const value = await readPinned($)
  // A read the sidebar answered before a press, or one taken while the change
  // is in flight, would put the old icon back: the press's icon stands.
  if (presses !== seen || (await read($, busy))) return
  await update($, pinned, () => value)
}

// Started by this module's first refresh, whatever runs it; module variables
// start over at a reload.
let timer: Timer | undefined
let presses = 0

async function toggle($: EngineInterface) {
  const current = await read($, pinned)
  if (current === null || (await read($, busy))) return
  presses += 1
  await update($, busy, () => true)
  // The icon turns at the press, in one redraw (a read-back after the change
  // drew it again, and a click could look lost); a refused change turns it back.
  await update($, pinned, () => !current)
  const change = current ? 'unpin' : 'pin'
  try {
    // A tool call, run the way Claude's own calls run: made as a bare
    // $.mcp.call, the change failed in the desktop app, while the
    // same call from Claude worked and reads through $.mcp.call still do.
    const outcome = await $.tool.call({
      tool: SET_PINNED,
      session_id: 'self',
      pinned: !current,
      consent: `The user pressed the pin button in the prompt footer to ${change} this session.`,
    })
    const reason = outcome.deny ?? (outcome.isError ? outcome.text : undefined)
    if (reason !== undefined) {
      await update($, pinned, () => current)
      $.ui.toast(`The sidebar did not take the change: ${reason}`)
    }
  } catch (error) {
    await update($, pinned, () => current)
    $.ui.toast(`The sidebar did not take the change: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await update($, busy, () => false)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  // Every press on the pin runs this module's code. Until the footer redraws
  // after a reload it still shows the replaced module's button, whose own
  // onPress runs in that unloaded module: the call fails there, and the toast
  // says "The sidebar did not take the change". Not awaited, so the press is
  // taken at once and never falls through to that onPress.
  on('ui.press', { plugin: 'star-pins', element: PIN }, ($, e) => {
    void toggle($)
    return { element: e.element }
  })

  // The footer's mode labels, right of the prompt, not the band above it: the
  // band holds one tree and Runway's rate-limit band never passes it on, so a
  // button there showed or vanished with the plugins' load order. The labels
  // drawn beneath (the engine's, any other plugin's) stay; the button leads
  // them. The desktop draws this group after the status line's readouts
  // (MacLoad), so there the pin sits between those and the model picker; the
  // left side, by Auto, holds no slot a plugin draws in.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const state = await read($, pinned)
    if (state === null) return next(e)

    const below = await next(e)
    const { Box, Button } = $.ui.resolve(e)

    // An icon, not words, so it takes little room, given as the label, which is
    // what the desktop draws. onPress runs only if the ui.press hook above
    // was skipped.
    return (
      <Box>
        <Button key={PIN} label={state ? PINNED_ICON : UNPINNED_ICON} onPress={() => void toggle($)} />
        {below}
      </Box>
    )
  })
}
