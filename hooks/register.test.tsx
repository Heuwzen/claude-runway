import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const NOW = Date.parse('2026-10-07T12:30:00Z')
const HOUR = 3_600_000
const SURFACES = ['terminal', 'desktop'] as const
const START = { cwd: '/Users/me/code/app', surface: 'desktop', isInteractive: true } as const

const PANE = {
  component: 'Pane',
  requestId: 'usage-breakdown',
  props: {
    title: 'Usage breakdown',
    isFocused: false,
    bodyColumns: 80,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const usage = (model: string, input: number, output: number, cacheWrite = 0, cacheRead = 0): Usage => ({
  model,
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
})

type Options = {
  stored?: Record<string, unknown>
  id?: string
  repo?: string | null
  cwd?: string
}

// Stands in for the engine beneath the plugin: its clock, its store, the session's id,
// folder and repository, the panes, and a model whose next response is `reply.usage`.
function engine(on: On, options: Options = {}) {
  const state = {
    id: options.id ?? 'chat-1',
    opened: [] as string[],
    registered: [] as string[],
    reply: { usage: usage('claude-opus-4-5-20251101', 100, 50, 10, 5000) as Usage | null },
    failStore: false,
  }
  const stored: Record<string, unknown> = { ...options.stored }
  const clock = mock.clock(on, { now: NOW })

  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.keys', () => ({ value: Object.keys(stored) }))
  on('store.delete', (_, e) => {
    delete stored[e.key]

    return { value: undefined }
  })
  on('store.set', (_, e) => {
    if (state.failStore) {
      throw new Error('store full')
    }

    stored[e.key] = e.value

    return { value: undefined }
  })
  on('session.id', () => ({ value: state.id }))
  on('session.cwd', () => ({ value: options.cwd ?? '/Users/me/code/app/src' }))
  on('session.repo', () => ({
    value: options.repo === null ? null : { root: options.repo ?? '/Users/me/code/app', remote: null, internal: false, name: null },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', (_, e) => {
    state.registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('ui.open', (_, e) => {
    state.opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: state.opened.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('turn.step', async function* (_, e) {
    const used = state.reply.usage
    yield { kind: 'text', index: 0, text: 'hi' } as const
    yield { kind: 'stop', stopReason: 'end_turn', usage: used } as const

    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: used } as const
  })

  return { state, stored, clock }
}

type Step = { agentId?: string; model?: string }

async function step($: Engine, extra: Step = {}) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-4-5', messageCount: 3, ...extra })
  const chunks: unknown[] = []
  let next = await stream.next()

  while (next.done !== true) {
    chunks.push(next.value)
    next = await stream.next()
  }

  return { chunks, result: next.value }
}

const hourKey = String(Math.floor(NOW / HOUR) * HOUR)

test('counts a request by model and source, and passes the response through untouched', async ($, on) => {
  const { stored } = engine(on)
  const { chunks, result } = await step($)

  expect(chunks).toEqual([
    { kind: 'text', index: 0, text: 'hi' },
    { kind: 'stop', stopReason: 'end_turn', usage: usage('claude-opus-4-5-20251101', 100, 50, 10, 5000) },
  ])
  expect(result.answer).toBe('hi')
  expect(stored['session:chat-1']).toEqual({
    project: 'app',
    updatedAt: NOW,
    hours: { [hourKey]: { 'claude-opus-4-5-20251101|main': [1, 100, 10, 5000, 50] } },
  })
})

test("counts a subagent's request as agents", async ($, on) => {
  const { stored } = engine(on)
  await step($, { agentId: 'agent-7' })

  expect(Object.keys((stored['session:chat-1'] as { hours: Record<string, object> }).hours[hourKey] ?? {})).toEqual([
    'claude-opus-4-5-20251101|agents',
  ])
})

test('records nothing for a request that got no response', async ($, on) => {
  const { stored, state } = engine(on)
  state.reply.usage = null
  const { result } = await step($)

  expect(result.usage).toBe(null)
  expect(stored).toEqual({})
})

test('writes at most every 30 seconds, and the last requests while the chat is quiet', async ($, on) => {
  const { stored, clock } = engine(on)
  const saved = () => (stored['session:chat-1'] as { hours: Record<string, Record<string, number[]>> } | undefined)
    ?.hours[hourKey]?.['claude-opus-4-5-20251101|main']?.[0]

  await step($)
  expect(saved()).toBe(1)

  await clock.advance(5_000)
  await step($)
  await step($)
  expect(saved()).toBe(1)

  await clock.advance(20_000)
  expect(saved()).toBe(1)

  await clock.advance(10_000)
  expect(saved()).toBe(3)
})

test('writes nothing when nothing changed', async ($, on) => {
  const { stored, clock } = engine(on)
  await step($)
  const first = stored['session:chat-1']
  delete stored['session:chat-1']
  await clock.advance(120_000)

  expect(first).toBeDefined()
  expect(stored['session:chat-1']).toBeUndefined()
})

test('names the project after the git top level, else the working folder', async ($, on) => {
  const { stored } = engine(on, { repo: '/Users/me/code/big-repo' })
  await step($)
  expect((stored['session:chat-1'] as { project: string }).project).toBe('big-repo')
})

test('names the project after the working folder outside a repository', async ($, on) => {
  const { stored } = engine(on, { repo: null, cwd: '/Users/me/notes/' })
  await step($)
  expect((stored['session:chat-1'] as { project: string }).project).toBe('notes')
})

test('keeps counting where a resumed chat left off', async ($, on) => {
  const earlier = {
    project: 'app',
    updatedAt: NOW - HOUR,
    hours: { [hourKey]: { 'claude-opus-4-5-20251101|main': [4, 400, 0, 0, 40] } },
  }
  const { stored } = engine(on, { stored: { 'session:chat-1': earlier } })
  await $.session.start(START)
  await step($)

  expect((stored['session:chat-1'] as { hours: Record<string, Record<string, number[]>> }).hours[hourKey]).toEqual({
    'claude-opus-4-5-20251101|main': [5, 500, 10, 5000, 90],
  })
})

test('starts a new record when the chat id changes, after saving the old one', async ($, on) => {
  const { stored, state, clock } = engine(on)
  await step($)
  await clock.advance(1_000)
  await step($)
  expect((stored['session:chat-1'] as { hours: Record<string, Record<string, number[]>> }).hours[hourKey]?.['claude-opus-4-5-20251101|main']?.[0]).toBe(1)

  state.id = 'chat-2'
  await step($)

  // The second request of chat-1 was waiting for its save and is not lost.
  expect((stored['session:chat-1'] as { hours: Record<string, Record<string, number[]>> }).hours[hourKey]?.['claude-opus-4-5-20251101|main']?.[0]).toBe(2)
  expect((stored['session:chat-2'] as { hours: Record<string, Record<string, number[]>> }).hours[hourKey]?.['claude-opus-4-5-20251101|main']?.[0]).toBe(1)
})

test('saves the waiting counts when the session ends', async ($, on) => {
  const { stored, clock } = engine(on)
  await step($)
  await clock.advance(1_000)
  await step($)
  await $.session.end({
    reason: 'other',
    sessionId: 'chat-1',
    resume: { id: 'chat-1' },
  } as never)

  expect((stored['session:chat-1'] as { hours: Record<string, Record<string, number[]>> }).hours[hourKey]?.['claude-opus-4-5-20251101|main']?.[0]).toBe(2)
})

test('prunes hours older than 8 days when saving', async ($, on) => {
  const old = String(Math.floor((NOW - 9 * 24 * HOUR) / HOUR) * HOUR)
  const earlier = { project: 'app', updatedAt: NOW - HOUR, hours: { [old]: { 'm|main': [1, 1, 0, 0, 0] } } }
  const { stored } = engine(on, { stored: { 'session:chat-1': earlier } })
  await step($)

  expect(Object.keys((stored['session:chat-1'] as { hours: object }).hours)).toEqual([hourKey])
})

test('deletes chats not updated for 8 days, and keeps the rest', async ($, on) => {
  const chat = (updatedAt: number) => ({ project: 'x', updatedAt, hours: {} })
  const { stored, clock } = engine(on, {
    stored: {
      'session:stale': chat(NOW - 9 * 24 * HOUR),
      'session:recent': chat(NOW - 2 * 24 * HOUR),
    },
  })
  await step($)
  await clock.advance(10_000)

  expect(Object.keys(stored).sort()).toEqual(['session:chat-1', 'session:recent'])
})

test('keeps counting when the store refuses a write', async ($, on) => {
  const { stored, state, clock } = engine(on)
  state.failStore = true
  const { result } = await step($)
  expect(result.answer).toBe('hi')
  expect(stored).toEqual({})

  state.failStore = false
  await clock.advance(40_000)
  expect((stored['session:chat-1'] as { hours: object }).hours).toBeDefined()
})

test('shows the empty state before anything is counted', async ($, on) => {
  engine(on)
  await $.command.run({ command: 'usage-breakdown', args: '' } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'UsageBreakdown', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: 'Nothing recorded yet: counting starts now.' })).toBeDefined()
    await ui.unmount()
  }
})

const other = {
  project: 'site',
  updatedAt: NOW,
  hours: {
    [hourKey]: { 'claude-sonnet-4-5|main': [3, 3_000, 0, 90_000, 1_000], 'claude-sonnet-4-5|agents': [2, 1_000, 0, 0, 1_000] },
    [String(Math.floor(NOW / HOUR) * HOUR - 24 * HOUR)]: { 'claude-opus-4-5|main': [1, 40_000, 0, 0, 10_000] },
  },
}

test('opens the pane and draws both windows, grouped three ways, on each surface', async ($, on) => {
  const { state } = engine(on, { stored: { 'session:chat-9': other } })
  await step($)
  const text = await $.command.run({ command: 'usage-breakdown', args: '' } as never)

  expect(text).toMatchObject({ text: 'Usage breakdown opened.' })
  expect(state.opened).toEqual(['usage-breakdown'])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'UsageBreakdown', surface, ...PANE })

    expect(await ui.find({ type: 'Text', text: 'Last 5 hours' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Last 7 days' })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: 'By model' })).toHaveLength(2)
    expect(await ui.findAll({ type: 'Text', text: 'By source' })).toHaveLength(2)
    expect(await ui.findAll({ type: 'Text', text: 'By project' })).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: 'Main chats' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Agents' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Opus 4.5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Sonnet 4.5' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'site' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'app' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /█/ })).toBeDefined()
    expect(
      await ui.find({
        type: 'Text',
        text: 'Shares of tokens, not of your limits: Opus uses more of your limits per token than Sonnet. Cache reads are left out.',
      }),
    ).toBeDefined()
    await ui.unmount()
  }
})

test('shares are of input, cache write and output, without cache reads', async ($, on) => {
  engine(on, { stored: { 'session:chat-9': other } })
  await step($)
  await $.command.run({ command: 'usage-breakdown', args: '' } as never)

  const ui = await $.ui.mount({ plugin: 'UsageBreakdown', surface: 'terminal', ...PANE })
  // Last 5 hours: this chat 160 tokens (100 + 10 + 50), the other 6,000 of Sonnet.
  expect(await ui.find({ type: 'Text', text: '6.2k tokens · 6 requests' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '97%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '3%' })).toBeDefined()
  await ui.unmount()
})

test('sizes the bars to the pane width', async ($, on) => {
  engine(on, { stored: { 'session:chat-9': other } })
  await $.command.run({ command: 'usage-breakdown', args: '' } as never)
  const longest = async (columns: number) => {
    const ui = await $.ui.mount({
      plugin: 'UsageBreakdown',
      surface: 'terminal',
      ...PANE,
      props: { ...PANE.props, bodyColumns: columns },
    })
    const bars = await ui.findAll({ type: 'Text', text: /^[▏▎▍▌▋▊▉█]+$/ })
    await ui.unmount()

    return Math.max(...bars.map(one => one.text?.length ?? 0))
  }

  expect(await longest(100)).toBeGreaterThan(await longest(60))
  expect(await longest(60)).toBeGreaterThan(await longest(40))
})

test('refreshes every 60 seconds while the pane is open, not before', async ($, on) => {
  const { stored, clock } = engine(on)
  await $.session.start(START)
  await $.command.run({ command: 'usage-breakdown', args: '' } as never)

  const ui = await $.ui.mount({ plugin: 'UsageBreakdown', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'Nothing recorded yet: counting starts now.' })).toBeDefined()
  await ui.unmount()

  stored['session:chat-9'] = other
  await clock.advance(30_000)

  const early = await $.ui.mount({ plugin: 'UsageBreakdown', surface: 'desktop', ...PANE })
  expect(await early.find({ type: 'Text', text: 'Nothing recorded yet: counting starts now.' })).toBeDefined()
  await early.unmount()

  await clock.advance(31_000)

  const later = await $.ui.mount({ plugin: 'UsageBreakdown', surface: 'desktop', ...PANE })
  expect(await later.find({ type: 'Text', text: 'Last 5 hours' })).toBeDefined()
  await later.unmount()
})

test('registers the command when the session starts', async ($, on) => {
  const { state } = engine(on)
  await $.session.start(START)

  expect(state.registered).toEqual(['usage-breakdown'])
})
