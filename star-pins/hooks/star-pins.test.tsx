import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const FOOTER = {
  plugin: 'star-pins',
  component: 'SessionMode',
  props: { modes: ['auto'] },
} as const

const text = (value: string) => ({ value: { content: [{ type: 'text' as const, text: value }], isError: false } })

// Stands for the desktop app's sidebar: reads answer over MCP, a pin change
// arrives as a tool call (refused with `refusal` when given). Holds this
// session's pin and each change asked of it.
function sidebar(on: On, refusal?: string) {
  const held = { isPinned: false, changes: [] as unknown[] }
  on('mcp.call', (_, e) => {
    if (e.server === 'ccd_session_mgmt' && e.tool === 'get_session') {
      return text(JSON.stringify({ sessionId: 'local_1', pinned: held.isPinned }))
    }
    return { value: { content: [], isError: true } }
  })
  on('tool.call', { tool: 'mcp__ccd_sidebar__set_pinned' }, (_, e) => {
    if (refusal !== undefined) return { deny: refusal }
    held.changes.push({ session_id: e.session_id, pinned: e.pinned })
    held.isPinned = e.pinned === true
    return { result: { content: [{ type: 'text', text: 'Session pinned.' }] }, text: 'Session pinned.' }
  })
  return held
}

test('the pin pins this session from the footer, and lights up while pinned', async ($, on) => {
  // Each hook here stands for the desktop app's sidebar and the engine.
  const { changes } = sidebar(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>auto</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })

  // The footer's own label stays, the button leads it.
  expect((await ui.find({ type: 'Text', text: /auto/ }))?.text).toBe('auto')
  // The state is in the label's characters, all the desktop footer draws: an
  // outline star while unpinned, a filled one while pinned.
  const pin = await ui.find({ type: 'Button', key: 'pin' })
  expect(pin?.text).toBe('☆')
  expect(pin?.props.label).toBe('☆')
  await ui.press({ plugin: 'star-pins', key: 'pin' })
  expect(changes).toEqual([{ session_id: 'self', pinned: true }])
  expect((await ui.find({ type: 'Button', key: 'pin' }))?.props.label).toBe('★')

  await ui.press({ plugin: 'star-pins', key: 'pin' })
  expect(changes).toEqual([
    { session_id: 'self', pinned: true },
    { session_id: 'self', pinned: false },
  ])
  expect((await ui.find({ type: 'Button', key: 'pin' }))?.props.label).toBe('☆')
  await ui.unmount()
})

test('without the desktop sidebar the footer is left as it was', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', () => ({ value: { content: [], isError: true } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>auto</Text>
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...FOOTER, surface: 'terminal' })

  expect(await ui.find({ type: 'Button', key: 'pin' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /auto/ }))?.text).toBe('auto')
  await ui.unmount()
})

test('a press runs this module, never the onPress of the button as drawn', async ($, on) => {
  const { changes } = sidebar(on)
  // Beneath the plugin's ui.press hook lies the drawn button's own onPress,
  // which after a reload can belong to the replaced, unloaded module.
  const fellThrough: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.press', (_, e) => {
    fellThrough.push(e.element)
    return { element: e.element }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>auto</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })

  expect(await ui.press({ plugin: 'star-pins', key: 'pin' })).toEqual({ element: 'pin' })
  expect(fellThrough).toEqual([])
  expect(changes).toEqual([{ session_id: 'self', pinned: true }])
  await ui.unmount()
})

test('a refused change says why, and the pin stays as the sidebar has it', async ($, on) => {
  const { changes } = sidebar(on, 'Sidebar tools are turned off right now.')
  const toasts: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>auto</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })

  await ui.press({ plugin: 'star-pins', key: 'pin' })
  expect(toasts).toEqual(['The sidebar did not take the change: Sidebar tools are turned off right now.'])
  expect(changes).toEqual([])
  expect((await ui.find({ type: 'Button', key: 'pin' }))?.props.label).toBe('☆')
  await ui.unmount()
})

test('a read the sidebar answers after a press does not turn the icon back', async ($, on) => {
  const changes: unknown[] = []
  // The first read answers at once; the second waits, as a timer's read can
  // while the person presses, then answers with the state before the press.
  let reads = 0
  let answerLate: (pinned: boolean) => void = () => {}
  on('mcp.call', (_, e) => {
    if (e.server !== 'ccd_session_mgmt' || e.tool !== 'get_session') {
      return { value: { content: [], isError: true } }
    }
    reads += 1
    if (reads === 1) return text(JSON.stringify({ pinned: false }))
    return new Promise(resolve => {
      answerLate = pinned => resolve(text(JSON.stringify({ pinned })))
    })
  })
  on('tool.call', { tool: 'mcp__ccd_sidebar__set_pinned' }, (_, e) => {
    changes.push({ session_id: e.session_id, pinned: e.pinned })
    return { result: { content: [{ type: 'text', text: 'Session pinned.' }] }, text: 'Session pinned.' }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>auto</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  const lateRead = $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await ui.press({ plugin: 'star-pins', key: 'pin' })
  expect(changes).toEqual([{ session_id: 'self', pinned: true }])
  answerLate(false)
  await lateRead
  expect((await ui.find({ type: 'Button', key: 'pin' }))?.props.label).toBe('★')
  await ui.unmount()
})
