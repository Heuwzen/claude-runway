import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-07T12:00:00Z')

const LIMITS = [
  { kind: 'five_hour', percentUsed: 62, resetsAt: '2026-10-07T13:00:00Z' },
  { kind: 'seven_day', percentUsed: 85, resetsAt: '2026-10-10T12:00:00Z' },
]

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const
const START = { cwd: '/tmp', surface: 'desktop', isInteractive: true } as const

// Stands in for the engine beneath the plugin: its clock, its store (holding `stored`),
// its session events (`context` as the chat's usage) and its toasts, collected in `toasts`.
function engine(on: On, stored: Record<string, unknown> = {}, context: { window: number; tokens?: number; percent?: number } = { window: 200_000 }) {
  const toasts: string[] = []
  mock.clock(on, { now: NOW })
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => {
    stored[e.key] = e.value

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, context, rateLimits: [] } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return toasts
}

test('waits for the first reply before drawing meters', async ($, on) => {
  engine(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'rate-limits', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: 'after the first reply' })).toBeDefined()
    await ui.unmount()
  }
})

test('draws a meter for each window on the terminal and the desktop', async ($, on) => {
  engine(on)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS, changed: ['rateLimits'] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'rate-limits', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: '5-hour' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'resets in 1h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Weekly' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /limit in/ }))?.text).toBe('→ limit in ~16h 56m · resets in 3d')

    if (surface === 'desktop') {
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(2)
    } else {
      expect(await ui.find({ type: 'Text', text: /━/ })).toBeDefined()
    }

    await ui.unmount()
  }
})

test('stacks the meters when the band is narrow', async ($, on) => {
  engine(on)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS, changed: ['rateLimits'] })

  const ui = await $.ui.mount({
    plugin: 'rate-limits',
    surface: 'terminal',
    ...BAND,
    props: { ...BAND.props, bodyColumns: 40 },
  })
  expect((await ui.find({ type: 'Box' }))?.props).toMatchObject({ flexDirection: 'column' })
  await ui.unmount()
})

test('toasts once as a window crosses 80%, and again at 95%', async ($, on) => {
  const toasts = engine(on)

  for (const percentUsed of [79, 81, 88, 96, 97]) {
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: '2026-10-07T13:00:00Z' }],
      changed: ['rateLimits'],
    })
  }

  expect(toasts).toEqual(['5-hour limit at 81%', '5-hour limit at 96%'])
})

test('starts from the newest saved reading, before the first reply', async ($, on) => {
  engine(on, { latest: { limits: LIMITS, at: NOW - 12 * 60_000 } })
  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'rate-limits', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'as of 12m ago · resets in 1h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /limit in/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('shows a window that reset since the saved reading as reset', async ($, on) => {
  const reading = { limits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: '2026-10-07T11:30:00Z' }], at: NOW - 3 * 3_600_000 }
  engine(on, { latest: reading })
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: 'rate-limits', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '0%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'reset since last reading' })).toBeDefined()
  await ui.unmount()
})

test("saves this chat's reading for the next chat", async ($, on) => {
  const stored: Record<string, unknown> = {}
  engine(on, stored)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS, changed: ['rateLimits'] })

  expect(stored.latest).toEqual({ limits: LIMITS, at: NOW })
})

test("adds this chat's context fill as a third meter once a reply reports it", async ($, on) => {
  engine(on)
  await $.session.measure({
    context: { window: 200_000, tokens: 82_000, percent: 41 },
    rateLimits: LIMITS,
    changed: ['context', 'rateLimits'],
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'rate-limits', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: 'Context ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '41%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '82k of 200k' })).toBeDefined()

    if (surface === 'desktop') {
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
    }

    await ui.unmount()
  }
})

test('keeps every tile to one line beside three meters, shedding the age first', async ($, on) => {
  engine(on, { latest: { limits: LIMITS, at: NOW - 2 * 60_000 } }, { window: 1_000_000, tokens: 735_000, percent: 74 })
  await $.session.start(START)

  for (const surface of SURFACES) {
    // About the width of the desktop band in the bug report: tiles 29 cells across.
    const ui = await $.ui.mount({ plugin: 'rate-limits', surface, ...BAND, props: { ...BAND.props, bodyColumns: 95 } })
    expect(await ui.find({ type: 'Text', text: 'resets in 1h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'resets in 3d' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /as of/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '735k of 1M' })).toBeDefined()
    await ui.unmount()
  }
})
