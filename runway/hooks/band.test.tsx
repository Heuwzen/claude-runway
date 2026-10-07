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
// its session events (`context` and `rateLimits` as the chat's usage at its start) and its
// toasts, collected in `toasts`.
function engine(
  on: On,
  stored: Record<string, unknown> = {},
  context: { window: number; tokens?: number; percent?: number } = { window: 200_000 },
  rateLimits: typeof LIMITS = [],
) {
  const toasts: string[] = []
  const clock = mock.clock(on, { now: NOW })
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => {
    stored[e.key] = e.value

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, context, rateLimits } }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return { toasts, clock }
}

test('waits for the first reply before drawing meters', async ($, on) => {
  engine(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'Runway', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: 'after the first reply' })).toBeDefined()
    await ui.unmount()
  }
})

test('draws a meter for each window on the terminal and the desktop', async ($, on) => {
  engine(on)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS, changed: ['rateLimits'] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'Runway', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: '5-hour' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'resets in 1h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Weekly' })).toBeDefined()
    // The terminal measures exactly and fits two facts; the desktop gives each figure one.
    expect((await ui.find({ type: 'Text', text: /limit in/ }))?.text).toBe(
      surface === 'terminal' ? '→ limit in ~16h 56m · resets in 3d' : '→ limit in ~16h 56m',
    )

    if (surface === 'desktop') {
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(2)
    } else {
      expect(await ui.find({ type: 'Text', text: /━/ })).toBeDefined()
    }

    await ui.unmount()
  }
})

test('stacks the meters when the band is narrow, and lines them up in one row when wide', async ($, on) => {
  engine(on)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS, changed: ['rateLimits'] })

  const narrow = await $.ui.mount({ plugin: 'Runway', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 40 } })
  const stacked = (await narrow.find({ type: 'Box' }))?.children as { props: Record<string, unknown> }[]
  expect(stacked.map(tile => tile.props.flexDirection)).toEqual(['column', 'column'])
  await narrow.unmount()

  // Wide: the figures in one row and the meters in the next, so the meters always line up.
  const wide = await $.ui.mount({ plugin: 'Runway', surface: 'desktop', ...BAND })
  const rows = (await wide.find({ type: 'Box' }))?.children as { children: { props: Record<string, unknown> }[] }[]
  expect(rows.map(row => row.children.length)).toEqual([2, 2])
  // Each figure's cell is a column, so its header spans the tile and the detail sits at its right end.
  expect(rows[0]?.children.map(cell => cell.props.flexDirection)).toEqual(['column', 'column'])
  await wide.unmount()
})

test('toasts once as a window crosses 80%, and again at 95%', async ($, on) => {
  const { toasts } = engine(on)

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
    const ui = await $.ui.mount({ plugin: 'Runway', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: surface === 'terminal' ? 'as of 12m ago · resets in 1h' : 'resets in 1h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /limit in/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('shows a window that reset since an old reading as reset, without a number', async ($, on) => {
  const reading = { limits: [{ kind: 'five_hour', percentUsed: 97, resetsAt: '2026-10-07T11:30:00Z' }], at: NOW - 3 * 3_600_000 }
  engine(on, { latest: reading })
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: 'Runway', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '5-hour' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'reset 30m ago' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
  await ui.unmount()
})

test('still shows the numbers of a reading up to an hour old', async ($, on) => {
  engine(on, { latest: { limits: LIMITS, at: NOW - 59 * 60_000 } })
  await $.session.start(START)

  const ui = await $.ui.mount({ plugin: 'Runway', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'no recent reading' })).toBeUndefined()
  await ui.unmount()
})

test('says there is no recent reading once the newest is an hour old, rather than show numbers', async ($, on) => {
  engine(on, { latest: { limits: LIMITS, at: NOW - 60 * 60_000 } }, { window: 1_000_000, tokens: 501_000, percent: 50 })
  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'Runway', surface, ...BAND })
    expect(await ui.findAll({ type: 'Text', text: 'no recent reading' })).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: /62%|85%/ })).toBeUndefined()
    // The chat's own context is live, so it keeps its number and its meter.
    expect(await ui.find({ type: 'Text', text: '50%' })).toBeDefined()

    if (surface === 'desktop') {
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
    }

    await ui.unmount()
  }

  // Where a terminal has the room, it says what brings a new reading.
  const wide = await $.ui.mount({ plugin: 'Runway', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 160 } })
  expect(await wide.findAll({ type: 'Text', text: 'no recent reading · a reply updates it' })).toHaveLength(2)
  await wide.unmount()
})

test('takes up a newer reading another chat saved within seconds', async ($, on) => {
  const stored: Record<string, unknown> = { latest: { limits: LIMITS, at: NOW - 60_000 } }
  const { clock } = engine(on, stored)
  await $.session.start(START)

  stored.latest = { limits: [{ kind: 'five_hour', percentUsed: 70, resetsAt: '2026-10-07T13:00:00Z' }], at: NOW + 1_000 }
  await clock.advance(5_000)

  const ui = await $.ui.mount({ plugin: 'Runway', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '70%' })).toBeDefined()
  await ui.unmount()
})

test('never passes the limits a chat holds at its start off as a new reading', async ($, on) => {
  const stored: Record<string, unknown> = {}
  engine(on, stored, { window: 200_000 }, LIMITS)
  await $.session.start(START)

  expect(stored.latest).toBe(undefined)
  const ui = await $.ui.mount({ plugin: 'Runway', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'after the first reply' })).toBeDefined()
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
    const ui = await $.ui.mount({ plugin: 'Runway', surface, ...BAND })
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
    const ui = await $.ui.mount({ plugin: 'Runway', surface, ...BAND, props: { ...BAND.props, bodyColumns: 95 } })
    expect(await ui.find({ type: 'Text', text: 'resets in 1h' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'resets in 3d' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /as of/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '735k of 1M' })).toBeDefined()
    await ui.unmount()
  }
})

test('gives each figure one fact on the desktop, whose text runs wider than its cells', async ($, on) => {
  engine(on, { latest: { limits: LIMITS, at: NOW - 11 * 60_000 } })
  await $.session.start(START)
  const wide = { ...BAND, props: { ...BAND.props, bodyColumns: 150 } }

  // The terminal's cells are its characters: the age fits beside the figure.
  const terminal = await $.ui.mount({ plugin: 'Runway', surface: 'terminal', ...wide })
  expect(await terminal.find({ type: 'Text', text: 'as of 11m ago · resets in 3d' })).toBeDefined()
  await terminal.unmount()

  // However many cells the desktop reports, its text is wider: one fact, no age.
  const desktop = await $.ui.mount({ plugin: 'Runway', surface: 'desktop', ...wide })
  expect(await desktop.find({ type: 'Text', text: 'resets in 3d' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: / · / })).toBeUndefined()
  await desktop.unmount()
})
