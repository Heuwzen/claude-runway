import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type { Report, Row, Section, Session } from '../types'
import {
  EMPTY,
  FOOTNOTE,
  KEY_PREFIX,
  SAVE_EVERY_MS,
  addRequest,
  bar,
  buildReport,
  compact,
  isEmpty,
  isSession,
  layoutOf,
  percent,
  projectOf,
  pruneHours,
  sweepPlan,
  widths,
} from './format'
import type { Layout, Source } from './format'

const sessionIdAtom = atom({ plugin: 'UsageBreakdown', key: 'sessionId' } as const, '')
const projectAtom = atom({ plugin: 'UsageBreakdown', key: 'project' } as const, '')
const hoursAtom = atom({ plugin: 'UsageBreakdown', key: 'hours' } as const, {})
const changesAtom = atom({ plugin: 'UsageBreakdown', key: 'changes' } as const, 0)
const savedAtom = atom({ plugin: 'UsageBreakdown', key: 'saved' } as const, 0)
const savedAtAtom = atom({ plugin: 'UsageBreakdown', key: 'savedAt' } as const, 0)
const sweptAtAtom = atom({ plugin: 'UsageBreakdown', key: 'sweptAt' } as const, 0)
const reportAtom = atom({ plugin: 'UsageBreakdown', key: 'report' } as const, { at: 0, sections: [] })

const PANE = 'usage-breakdown'
const SWEEP_EVERY_MS = 3_600_000

// The accent used for fills elsewhere, checked against light and dark surfaces alike.
const BAR_COLOR = '#3987e5'

// The module's own variables reset on a reload, as the timers do, so they stay in step.
let isTicking = false
let attaching: Promise<string> | undefined

type Elements = Pick<ElementTable<'terminal'>, 'Box' | 'Text'>

// Makes the chat on show the one the counts belong to: loads what it saved before
// (a resumed chat), and saves the previous chat's counts first when the id has moved on.
async function attachNow($: EngineInterface) {
  const id = await $.session.id()

  if ((await read($, sessionIdAtom)) === id) {
    return id
  }

  await save($, true)

  let stored: unknown

  try {
    stored = await $.store.get(`${KEY_PREFIX}${id}`)
  } catch {
    stored = undefined
  }

  const now = await $.clock.now()
  const cwd = await $.session.cwd()
  const repo = await $.session.repo()

  await update($, hoursAtom, () => (isSession(stored) ? pruneHours(stored.hours, now) : {}))
  await update($, projectAtom, () => projectOf(cwd, repo?.root))
  await update($, changesAtom, () => 0)
  await update($, savedAtom, () => 0)
  await update($, savedAtAtom, () => 0)
  await update($, sessionIdAtom, () => id)

  return id
}

// One at a time, so two requests ending together do not both load over the other's count.
function attach($: EngineInterface) {
  attaching ??= attachNow($).finally(() => {
    attaching = undefined
  })

  return attaching
}

// Writes this chat's counts when they changed, at most every 30 seconds unless forced.
async function save($: EngineInterface, isForced: boolean) {
  const id = await read($, sessionIdAtom)
  const changes = await read($, changesAtom)

  if (id === '' || changes === (await read($, savedAtom))) {
    return
  }

  const now = await $.clock.now()

  if (!isForced && now - (await read($, savedAtAtom)) < SAVE_EVERY_MS) {
    return
  }

  const hours = pruneHours(await read($, hoursAtom), now)

  try {
    await $.store.set(`${KEY_PREFIX}${id}`, { project: await read($, projectAtom), updatedAt: now, hours })
  } catch {
    // The store is full or unwritable: keep counting, try again later.
    return
  }

  await update($, hoursAtom, current => pruneHours(current, now))
  await update($, savedAtom, () => changes)
  await update($, savedAtAtom, () => now)
}

// Deletes the chats nobody has updated for 8 days, and the oldest ones if the store gets big.
async function sweep($: EngineInterface) {
  const now = await $.clock.now()
  const own = `${KEY_PREFIX}${await read($, sessionIdAtom)}`
  const entries = []

  await update($, sweptAtAtom, () => now)

  for (const key of await $.store.keys()) {
    if (key.startsWith(KEY_PREFIX)) {
      entries.push({ key, value: await $.store.get(key) })
    }
  }

  for (const key of sweepPlan(entries, now, own)) {
    await $.store.delete(key)
  }
}

async function tick($: EngineInterface) {
  await save($, false)

  if ((await $.clock.now()) - (await read($, sweptAtAtom)) >= SWEEP_EVERY_MS) {
    await sweep($)
  }
}

// Every chat's saved counts, with this chat's own taken live rather than as last saved.
async function sessionsOf($: EngineInterface): Promise<Session[]> {
  const id = await read($, sessionIdAtom)
  const own = `${KEY_PREFIX}${id}`
  const sessions: Session[] = []

  for (const key of await $.store.keys()) {
    if (key.startsWith(KEY_PREFIX) && key !== own) {
      const value = await $.store.get(key)

      if (isSession(value)) {
        sessions.push(value)
      }
    }
  }

  if (id !== '') {
    sessions.push({
      project: await read($, projectAtom),
      updatedAt: await $.clock.now(),
      hours: await read($, hoursAtom),
    })
  }

  return sessions
}

async function refresh($: EngineInterface) {
  const now = await $.clock.now()
  const report = buildReport(await sessionsOf($), now)

  await update($, reportAtom, () => report)
}

async function refreshIfOpen($: EngineInterface) {
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
    await refresh($)
  }
}

// Saves on a short timer so the last requests of a quiet chat are not left unwritten,
// and refreshes the pane while it is open.
function startTimers($: EngineInterface) {
  if (isTicking) {
    return
  }

  isTicking = true
  $.clock.every(10_000, () => void tick($).catch(() => undefined))
  $.clock.every(60_000, () => void refreshIfOpen($).catch(() => undefined))
}

type Step = { model: string; agentId?: string | undefined }
type Used = { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

// Adds one model request to this chat's current hour.
async function record($: EngineInterface, step: Step, used: Used | null) {
  if (used === null) {
    return
  }

  await attach($)

  const now = await $.clock.now()
  const model = used.model === '' ? step.model : used.model
  const source: Source = step.agentId === undefined ? 'main' : 'agents'

  await update($, hoursAtom, hours => addRequest(hours, now, model, source, used))
  await update($, changesAtom, changes => changes + 1)
  await save($, false)
  startTimers($)
}

type RowProps = { elements: Elements; row: Row; layout: Layout }

function BarRow({ elements, row, layout }: RowProps) {
  const { Box, Text } = elements

  return (
    <Box columnGap={1}>
      <Box width={layout.label}>
        <Text wrap="truncate-end">{row.label}</Text>
      </Box>
      <Box width={layout.bar}>
        <Text color={BAR_COLOR}>{bar(row.share, layout.bar)}</Text>
      </Box>
      <Box width={widths.percent} justifyContent="flex-end">
        <Text>{percent(row.share)}</Text>
      </Box>
      <Box width={widths.tokens} justifyContent="flex-end">
        <Text dimColor>{compact(row.tokens)}</Text>
      </Box>
    </Box>
  )
}

type GroupProps = { elements: Elements; title: string; rows: readonly Row[]; layout: Layout }

function Group({ elements, title, rows, layout }: GroupProps) {
  const { Box, Text } = elements

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>{title}</Text>
      {rows.map(row => (
        <BarRow elements={elements} row={row} layout={layout} />
      ))}
    </Box>
  )
}

type SectionProps = { elements: Elements; section: Section; layout: Layout }

function SectionView({ elements, section, layout }: SectionProps) {
  const { Box, Text } = elements
  const requests = `${section.requests} request${section.requests === 1 ? '' : 's'}`

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box columnGap={1}>
        <Text bold>{section.title}</Text>
        <Text dimColor>{`${compact(section.tokens)} tokens · ${requests}`}</Text>
      </Box>
      {section.tokens === 0 ? (
        <Text dimColor>Nothing in this window.</Text>
      ) : (
        <Box flexDirection="column">
          <Group elements={elements} title="By model" rows={section.models} layout={layout} />
          <Group elements={elements} title="By source" rows={section.sources} layout={layout} />
          <Group elements={elements} title="By project" rows={section.projects} layout={layout} />
        </Box>
      )}
    </Box>
  )
}

type PaneProps = { elements: Elements; report: Report; columns: number }

function PaneView({ elements, report, columns }: PaneProps) {
  const { Box, Text } = elements

  if (isEmpty(report)) {
    return (
      <Box>
        <Text dimColor>{EMPTY}</Text>
      </Box>
    )
  }

  // One layout for every group, so the columns line up down the pane.
  const labels = report.sections.flatMap(section => [...section.models, ...section.sources, ...section.projects])
  const layout = layoutOf(columns, Math.max(...labels.map(row => row.label.length)))

  return (
    <Box flexDirection="column">
      {report.sections.map(section => (
        <SectionView elements={elements} section={section} layout={layout} />
      ))}
      <Box marginTop={1}>
        <Text dimColor>{FOOTNOTE}</Text>
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-breakdown',
      description: 'Show which models, agents and projects use your tokens',
    })

    try {
      await attach($)
    } catch {
      // Counting begins with the first request instead.
    }

    startTimers($)

    return next(e)
  })

  // A step is one model request, the main chat's or an agent's. The stream passes through
  // untouched; the usage is read off its result once the response is whole.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)

    try {
      await record($, e, result.usage)
    } catch {
      // Counting must never get in the way of a turn.
    }

    return result
  })

  on('session.end', async ($, e, next) => {
    try {
      await save($, true)
    } catch {
      // Whatever was not saved is lost; the exit goes on.
    }

    return next(e)
  })

  on('command.run', { command: 'usage-breakdown' }, async $ => {
    try {
      await refresh($)
    } catch {
      // The pane shows what it last had.
    }

    startTimers($)
    await $.ui.open({ id: PANE, title: 'Usage breakdown' })

    return { text: 'Usage breakdown opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    let report = await read($, reportAtom)

    if (report.at === 0) {
      try {
        await refresh($)
        report = await read($, reportAtom)
      } catch {
        // Falls through to the empty state.
      }
    }

    return <PaneView elements={{ Box, Text }} report={report} columns={e.props.bodyColumns} />
  })
}
