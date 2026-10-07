import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement } from 'claude-code'

import type { Context, Limit } from '../types'
import { OLD_AFTER, brief, contextDetailsOf, detailsOf, fitting, isReading, labelOf, oldDetailsOf, severityOf, thresholdOf, viewOf } from './format'
import type { LimitView, Segment, Severity, Tone } from './format'
import { METER_HEIGHT, meterRuns, meterSvg } from './meter'
import type { MeterRole } from './meter'

const limitsAtom = atom({ plugin: 'RateLimits', key: 'limits' } as const, [])
const contextAtom = atom({ plugin: 'RateLimits', key: 'context' } as const, null)
const readingAtAtom = atom({ plugin: 'RateLimits', key: 'readingAt' } as const, 0)
const nowAtom = atom({ plugin: 'RateLimits', key: 'now' } as const, 0)
const toastedAtom = atom({ plugin: 'RateLimits', key: 'toasted' } as const, {})

// The store key every chat saves its latest reading under, for the next chat to start from.
const LATEST = 'latest'

// Checked against light and dark surfaces alike, since a mod cannot tell which
// theme it draws on: accent, warning and critical fills, and the muted ink.
const COLORS: Record<Severity, string> = {
  normal: '#3987e5',
  warning: '#c98500',
  critical: '#d03b3b',
}
const MUTED = '#898781'

const GAP = 3
const MIN_TILE = 22
const MAX_TILE = 48
// More CSS pixels than a desktop cell holds, so a meter drawn this wide is
// always narrowed to its tile rather than falling short of it.
const PX_PER_CELL = 9

type Elements = Pick<ElementTable<'terminal'>, 'Box' | 'Text'>
type Meter = (view: LimitView, width: number, color: string, alt: string) => RenderElement

function layoutOf(columns: number, count: number) {
  const fit = Math.floor((columns - GAP * (count - 1)) / count)

  return fit >= MIN_TILE
    ? { direction: 'row' as const, tile: Math.min(MAX_TILE, fit) }
    : { direction: 'column' as const, tile: Math.min(MAX_TILE, columns) }
}

function altOf(limit: Limit, view: LimitView) {
  const used = `${labelOf(limit.kind)} limit, ${Math.round(view.percent)}% used`

  return view.elapsed === undefined ? used : `${used}, ${Math.round(view.elapsed * 100)}% of the window gone`
}

function runStyle(role: MeterRole, color: string) {
  switch (role) {
    case 'fill':
      return { color }
    case 'mark-fill':
      return { color, bold: true }
    case 'mark-empty':
      return { color: MUTED }
    case 'empty':
      return { dimColor: true }
  }
}

const markOf = (severity: Severity) => (severity === 'critical' ? '◆ ' : '▲ ')

// A label and its percentage; the label alone where the reading is too old to show.
type FigureProps = { elements: Elements; label: string; percent?: number | undefined }

function Figure({ elements, label, percent }: FigureProps) {
  const { Box, Text } = elements

  if (percent === undefined) {
    return (
      <Box flexShrink={0}>
        <Text>{label}</Text>
      </Box>
    )
  }

  const severity = severityOf(percent)

  return (
    <Box flexShrink={0}>
      <Text>{`${label} `}</Text>
      {severity !== 'normal' && <Text color={COLORS[severity]}>{markOf(severity)}</Text>}
      <Text bold>{`${Math.round(percent)}%`}</Text>
    </Box>
  )
}

// The cells a tile `width` across has left beside its figure, after the gap between them.
function roomBeside(label: string, percent: number | undefined, width: number) {
  const severity = percent === undefined ? 'normal' : severityOf(percent)
  const figure = percent === undefined ? label : `${label} ${severity === 'normal' ? '' : markOf(severity)}${Math.round(percent)}%`

  return width - figure.length - 1
}

function toneStyle(tone: Tone) {
  switch (tone) {
    case 'plain':
      return {}
    case 'dim':
      return { dimColor: true }
    case 'warning':
      return { color: COLORS.warning }
  }
}

type DetailProps = { elements: Elements; segments: readonly Segment[] }

// Measured to fit rather than left to wrap. A lone run is plain text, the likeliest to be
// cut short with an ellipsis where a surface's text runs wider than measured.
function Detail({ elements, segments }: DetailProps) {
  const { Box, Text } = elements
  const [only] = segments

  return (
    <Box flexShrink={1} minWidth={0}>
      {segments.length === 1 && only !== undefined ? (
        <Text {...toneStyle(only.tone)} wrap="truncate-end">
          {only.text}
        </Text>
      ) : (
        <Text wrap="truncate-end">
          {segments.map(segment => (
            <Text {...toneStyle(segment.tone)}>{segment.text}</Text>
          ))}
        </Text>
      )}
    </Box>
  )
}

type HeaderProps = {
  elements: Elements
  label: string
  percent?: number | undefined
  candidates: readonly Segment[][]
  width: number
}

// The figure, and the fullest detail that fits beside it on one line.
function Header({ elements, label, percent, candidates, width }: HeaderProps) {
  const { Box } = elements
  const segments = fitting(candidates, roomBeside(label, percent, width))

  return (
    <Box justifyContent="space-between" alignItems="flex-start" columnGap={1}>
      <Figure elements={elements} label={label} percent={percent} />
      {segments.length > 0 && <Detail elements={elements} segments={segments} />}
    </Box>
  )
}

// A tile's two parts: its figure and detail, and its meter, which a reading too old to
// show goes without.
type Column = { header: RenderElement; meter?: RenderElement }

type Shape = { width: number; isBrief: boolean; isOld: boolean; meter: Meter }

function limitColumn(elements: Elements, limit: Limit, view: LimitView, { width, isBrief, isOld, meter }: Shape): Column {
  const label = labelOf(limit.kind)
  const pick = (candidates: readonly Segment[][]) => (isBrief ? brief(candidates) : candidates)

  if (isOld) {
    return { header: <Header elements={elements} label={label} candidates={pick(oldDetailsOf(view))} width={width} /> }
  }

  return {
    header: <Header elements={elements} label={label} percent={view.percent} candidates={pick(detailsOf(view))} width={width} />,
    meter: meter(view, width, COLORS[severityOf(view.percent)], altOf(limit, view)),
  }
}

function contextColumn(elements: Elements, context: Context, width: number, meter: Meter): Column {
  return {
    header: <Header elements={elements} label="Context" percent={context.percent} candidates={contextDetailsOf(context)} width={width} />,
    meter: meter(
      { percent: context.percent, hasReset: false },
      width,
      COLORS[severityOf(context.percent)],
      `Context window, ${Math.round(context.percent)}% full`,
    ),
  }
}

type BandProps = {
  elements: Elements
  limits: readonly Limit[]
  context: Context | null
  now: number
  readingAt: number
  columns: number
  isBrief: boolean
  meter: Meter
}

function Band({ elements, limits, context, now, readingAt, columns, isBrief, meter }: BandProps) {
  const { Box, Text } = elements

  if (limits.length === 0 && !context) {
    return (
      <Box>
        <Text dimColor>Rate limits show up here after the first reply</Text>
      </Box>
    )
  }

  const { direction, tile } = layoutOf(columns, limits.length + (context ? 1 : 0))
  // The newest reading any chat has: too old, and its numbers are left out rather than shown wrong.
  const shape = { width: tile, isBrief, isOld: now - readingAt >= OLD_AFTER, meter }
  const all = [
    ...limits.map(limit => limitColumn(elements, limit, viewOf(limit, now, readingAt), shape)),
    ...(context ? [contextColumn(elements, context, tile, meter)] : []),
  ]

  if (direction === 'column') {
    return (
      <Box flexDirection="column">
        {all.map(column => (
          <Box flexDirection="column" width={tile}>
            {column.header}
            {column.meter !== undefined && column.meter}
          </Box>
        ))}
      </Box>
    )
  }

  // The figures in one row and the meters in the next, so every meter starts on the
  // same line, whatever the text above it does.
  return (
    <Box flexDirection="column">
      <Box columnGap={GAP}>
        {all.map(column => (
          <Box width={tile}>
            {column.header}
          </Box>
        ))}
      </Box>
      <Box columnGap={GAP}>
        {all.map(column => (
          <Box width={tile}>
            {column.meter !== undefined && column.meter}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

// Keep this chat's context fill once a reply has reported it.
async function measureContext($: EngineInterface, usage: { tokens?: number; window: number; percent?: number }) {
  const { tokens, window, percent } = usage

  if (tokens !== undefined && percent !== undefined) {
    await update($, contextAtom, () => ({ tokens, window, percent }))
  }
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
}

// Show a reading; this chat's own readings are also saved for the next chat.
async function adopt($: EngineInterface, limits: Limit[], at: number, isOwn: boolean) {
  await update($, limitsAtom, () => limits)
  await update($, readingAtAtom, () => at)

  if (isOwn) {
    await $.store.set(LATEST, { limits, at })
  }
}

// Take the reading another chat saved when it is newer than the one on show.
async function catchUp($: EngineInterface) {
  const saved = await $.store.get(LATEST)

  if (isReading(saved) && saved.at > (await read($, readingAtAtom))) {
    await adopt($, saved.limits, saved.at, false)
  }
}

async function refresh($: EngineInterface) {
  await tick($)
  // A store that cannot be read leaves this chat's own reading on show.
  await catchUp($).catch(() => undefined)
}

// Toasts each window once per threshold it crosses; a reset re-arms it.
async function alert($: EngineInterface, limits: readonly Limit[]) {
  const toasted = await read($, toastedAtom)
  const reached: Record<string, number> = {}

  for (const limit of limits) {
    const threshold = thresholdOf(limit.percentUsed)

    if (threshold === undefined) {
      continue
    }

    const last = toasted[limit.kind]

    if (last === undefined || threshold > last) {
      $.ui.toast(`${labelOf(limit.kind)} limit at ${Math.round(limit.percentUsed)}%`, {
        timeoutMs: 8000,
      })
    }

    reached[limit.kind] = threshold
  }

  await update($, toastedAtom, () => reached)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The chat's own context, which is live. Its rate limits are left to replies and to
    // the saved reading: what the engine holds at a start may be a quiet chat's last
    // numbers, and stamping them now would pass them off as new to every chat.
    const { context } = await $.session.usage()
    await measureContext($, context)
    await refresh($)
    // Takes up a newer reading another chat saved within seconds, so every chat shows the same.
    $.clock.every(5_000, () => void catchUp($).catch(() => undefined))
    // Keeps the countdowns current between replies.
    $.clock.every(60_000, () => void tick($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await measureContext($, e.context)

    if (e.rateLimits.length > 0) {
      await adopt($, [...e.rateLimits], await $.clock.now(), true)

      if (e.changed.includes('rateLimits')) {
        await alert($, e.rateLimits)
      }
    }

    await tick($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const limits = await read($, limitsAtom)
    const context = await read($, contextAtom)
    const readingAt = await read($, readingAtAtom)
    const now = (await read($, nowAtom)) || (await $.clock.now())
    const columns = e.props.bodyColumns

    if (e.surface === 'desktop') {
      const { Box, Text, Svg } = $.ui.resolve(e)
      const meter: Meter = (view, width, color, alt) => (
        <Svg
          source={meterSvg(width * PX_PER_CELL, view.percent, view.elapsed, color, MUTED)}
          alt={alt}
          height={METER_HEIGHT}
        />
      )

      return (
        <Band
          elements={{ Box, Text }}
          limits={limits}
          context={context}
          now={now}
          readingAt={readingAt}
          columns={columns}
          isBrief
          meter={meter}
        />
      )
    }

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      const meter: Meter = (view, width, color) => (
        <Box>
          {meterRuns(width, view.percent, view.elapsed).map(run => (
            <Text {...runStyle(run.role, color)}>{run.text}</Text>
          ))}
        </Box>
      )

      return (
        <Band elements={{ Box, Text }} limits={limits} context={context} now={now} readingAt={readingAt} columns={columns} isBrief={false} meter={meter} />
      )
    }

    return next(e)
  })
}
