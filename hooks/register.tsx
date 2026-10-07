import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement } from 'claude-code'

import type { Limit } from '../types'
import { formatDuration, isReading, labelOf, severityOf, thresholdOf, viewOf } from './format'
import type { LimitView, Severity } from './format'
import { METER_HEIGHT, meterRuns, meterSvg } from './meter'
import type { MeterRole } from './meter'

const limitsAtom = atom({ plugin: 'rate-limits', key: 'limits' } as const, [])
const readingAtAtom = atom({ plugin: 'rate-limits', key: 'readingAt' } as const, 0)
const nowAtom = atom({ plugin: 'rate-limits', key: 'now' } as const, 0)
const toastedAtom = atom({ plugin: 'rate-limits', key: 'toasted' } as const, {})

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

type TileProps = { elements: Elements; limit: Limit; view: LimitView; width: number; meter: Meter }

function Tile({ elements, limit, view, width, meter }: TileProps) {
  const { Box, Text } = elements
  const severity = severityOf(view.percent)
  const color = COLORS[severity]
  // One line beside the figure, the most urgent part first.
  const detail: RenderElement[] = []

  if (view.hasReset) {
    detail.push(<Text dimColor>reset since last reading</Text>)
  } else {
    if (view.percent >= 100) {
      detail.push(<Text>Limit reached</Text>)
    } else if (view.forecastMs !== undefined) {
      detail.push(
        // An arrow, not a second ▲: a projection, beside the figure's own warning.
        <Text color={COLORS.warning}>{'→ '}</Text>,
        <Text>{`limit in ~${formatDuration(view.forecastMs)}`}</Text>,
      )
    }

    const notes = [view.age && `as of ${view.age} ago`, view.resets && `resets in ${view.resets}`].filter(Boolean)

    if (notes.length > 0) {
      detail.push(<Text dimColor>{`${detail.length > 0 ? ' · ' : ''}${notes.join(' · ')}`}</Text>)
    }
  }

  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between" columnGap={1}>
        <Box flexShrink={0}>
          <Text>{`${labelOf(limit.kind)} `}</Text>
          {severity !== 'normal' && <Text color={color}>{severity === 'critical' ? '◆ ' : '▲ '}</Text>}
          <Text bold>{`${Math.round(view.percent)}%`}</Text>
        </Box>
        {detail.length > 0 && <Text wrap="truncate-end">{detail}</Text>}
      </Box>
      {meter(view, width, color, altOf(limit, view))}
    </Box>
  )
}

type BandProps = {
  elements: Elements
  limits: readonly Limit[]
  now: number
  readingAt: number
  columns: number
  meter: Meter
}

function Band({ elements, limits, now, readingAt, columns, meter }: BandProps) {
  const { Box, Text } = elements

  if (limits.length === 0) {
    return (
      <Box>
        <Text dimColor>Rate limits show up here after the first reply</Text>
      </Box>
    )
  }

  const { direction, tile } = layoutOf(columns, limits.length)

  return (
    <Box flexDirection={direction} columnGap={GAP}>
      {limits.map(limit => (
        <Tile elements={elements} limit={limit} view={viewOf(limit, now, readingAt)} width={tile} meter={meter} />
      ))}
    </Box>
  )
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
  await catchUp($)
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
    const { rateLimits } = await $.session.usage()

    if (rateLimits.length > 0 && (await read($, readingAtAtom)) === 0) {
      await adopt($, [...rateLimits], await $.clock.now(), true)
    }

    await refresh($)
    // Keeps the countdowns current between replies, and picks up readings other chats save.
    $.clock.every(60_000, () => void refresh($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
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
        <Band elements={{ Box, Text }} limits={limits} now={now} readingAt={readingAt} columns={columns} meter={meter} />
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
        <Band elements={{ Box, Text }} limits={limits} now={now} readingAt={readingAt} columns={columns} meter={meter} />
      )
    }

    return next(e)
  })
}
