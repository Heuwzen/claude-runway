import type { Counts, Hours, Report, Row, Section, Session } from '../types'

export const HOUR = 3_600_000
const DAY = 24 * HOUR

// How long counts are kept, and how often a chat saves at most.
export const KEEP_MS = 8 * DAY
export const SAVE_EVERY_MS = 30_000

export const KEY_PREFIX = 'session:'

// Well under the store's 4 MiB, which every chat's counts share.
const MAX_BYTES = 2 * 1024 * 1024
const TRIM_TO_BYTES = 1.5 * 1024 * 1024

const WINDOWS = [
  { title: 'Last 5 hours', ms: 5 * HOUR },
  { title: 'Last 7 days', ms: 7 * DAY },
]

export const MODEL_LIMIT = 8
export const PROJECT_LIMIT = 6

export type Source = 'main' | 'agents'

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

export const hourOf = (now: number) => Math.floor(now / HOUR) * HOUR

// Adds one request to the hour it was made in, without touching what was there.
export function addRequest(hours: Hours, now: number, model: string, source: Source, usage: Usage): Hours {
  const start = String(hourOf(now))
  const key = `${model}|${source}`
  const hour = hours[start] ?? {}
  const was = hour[key] ?? [0, 0, 0, 0, 0]
  const next: Counts = [
    was[0] + 1,
    was[1] + count(usage.input_tokens),
    was[2] + count(usage.cache_creation_input_tokens),
    was[3] + count(usage.cache_read_input_tokens),
    was[4] + count(usage.output_tokens),
  ]

  return { ...hours, [start]: { ...hour, [key]: next } }
}

// Drops the hours too old to count.
export function pruneHours(hours: Hours, now: number): Hours {
  const kept: Hours = {}

  for (const [start, hour] of Object.entries(hours)) {
    if (Number(start) + HOUR > now - KEEP_MS) {
      kept[start] = hour
    }
  }

  return kept
}

const isCounts = (value: unknown): value is Counts =>
  Array.isArray(value) && value.length === 5 && value.every(one => typeof one === 'number' && Number.isFinite(one))

// Whether a value read back from the store is a chat this mod saved.
export function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const { project, updatedAt, hours } = value as Partial<Session>

  if (typeof project !== 'string' || typeof updatedAt !== 'number' || typeof hours !== 'object' || hours === null) {
    return false
  }

  return Object.values(hours).every(
    hour => typeof hour === 'object' && hour !== null && Object.values(hour).every(isCounts),
  )
}

export type Entry = { key: string; value: unknown }

// Which saved chats to delete: those not updated for 8 days or unreadable, then the
// least recently updated until the rest fit, never `own`.
export function sweepPlan(entries: readonly Entry[], now: number, own: string): string[] {
  const doomed: string[] = []
  const kept: { key: string; updatedAt: number; bytes: number }[] = []

  for (const { key, value } of entries) {
    if (!key.startsWith(KEY_PREFIX) || key === own) {
      continue
    }

    if (!isSession(value) || value.updatedAt < now - KEEP_MS) {
      doomed.push(key)
    } else {
      kept.push({ key, updatedAt: value.updatedAt, bytes: JSON.stringify(value).length })
    }
  }

  let total = kept.reduce((sum, one) => sum + one.bytes, 0)

  if (total > MAX_BYTES) {
    for (const one of kept.sort((a, b) => a.updatedAt - b.updatedAt)) {
      if (total <= TRIM_TO_BYTES) {
        break
      }

      doomed.push(one.key)
      total -= one.bytes
    }
  }

  return doomed
}

// The part of a path after its last slash, ignoring trailing slashes.
export function basename(path: string) {
  const parts = path.split('/').filter(part => part !== '')

  return parts.at(-1) ?? path
}

// The project a chat belongs to: its git top level when there is one, else its working folder.
export function projectOf(cwd: string, gitTop: string | undefined) {
  const top = gitTop?.trim()

  return basename(top !== undefined && top !== '' ? top : cwd) || 'unknown'
}

const FAMILY = /(opus|sonnet|haiku)/
const NEW_NAME = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/
const OLD_NAME = /claude-(\d+)(?:-(\d{1,2})(?!\d))?-(opus|sonnet|haiku)/

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

// A short name for a model id: claude-opus-4-5-20251101 reads Opus 4.5.
export function modelLabel(model: string) {
  const id = model.toLowerCase().replace(/\[.*\]$/, '')
  const next = NEW_NAME.exec(id)

  if (next?.[1] !== undefined && next[2] !== undefined) {
    return `${capitalize(next[1])} ${next[2]}${next[3] === undefined ? '' : `.${next[3]}`}`
  }

  const old = OLD_NAME.exec(id)

  if (old?.[1] !== undefined && old[3] !== undefined) {
    return `${capitalize(old[3])} ${old[1]}${old[2] === undefined ? '' : `.${old[2]}`}`
  }

  const family = FAMILY.exec(id)?.[1]

  if (family !== undefined) {
    return capitalize(family)
  }

  return id.replace(/^claude-/, '') || 'unknown'
}

// What counts toward a share: everything but cache reads.
export const tokensOf = (counts: Counts) => counts[1] + counts[2] + counts[4]

type Tally = { tokens: number; requests: number }

const bump = (map: Map<string, Tally>, label: string, counts: Counts) => {
  const was = map.get(label) ?? { tokens: 0, requests: 0 }
  map.set(label, { tokens: was.tokens + tokensOf(counts), requests: was.requests + counts[0] })
}

// The biggest `limit` rows, the rest folded into "Other"; each row's share is of `total`.
export function rowsOf(map: Map<string, Tally>, total: number, limit: number): Row[] {
  const rows = [...map.entries()]
    .filter(([, tally]) => tally.tokens > 0)
    .map(([label, tally]) => ({ label, tokens: tally.tokens }))
    .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label))
  const top = rows.slice(0, limit)
  const rest = rows.slice(limit).reduce((sum, row) => sum + row.tokens, 0)

  if (rest > 0) {
    top.push({ label: 'Other', tokens: rest })
  }

  return top.map(row => ({ ...row, share: total > 0 ? row.tokens / total : 0 }))
}

function sectionOf(sessions: readonly Session[], now: number, title: string, ms: number): Section {
  const models = new Map<string, Tally>()
  const sources = new Map<string, Tally>([
    ['Main chats', { tokens: 0, requests: 0 }],
    ['Agents', { tokens: 0, requests: 0 }],
  ])
  const projects = new Map<string, Tally>()
  let tokens = 0
  let requests = 0

  for (const session of sessions) {
    for (const [start, hour] of Object.entries(session.hours)) {
      // An hour counts while any of it is inside the window.
      if (Number(start) + HOUR <= now - ms) {
        continue
      }

      for (const [key, counts] of Object.entries(hour)) {
        const cut = key.lastIndexOf('|')
        const model = modelLabel(key.slice(0, cut))
        const source = key.slice(cut + 1) === 'agents' ? 'Agents' : 'Main chats'

        tokens += tokensOf(counts)
        requests += counts[0]
        bump(models, model, counts)
        bump(sources, source, counts)
        bump(projects, session.project, counts)
      }
    }
  }

  return {
    title,
    tokens,
    requests,
    models: rowsOf(models, tokens, MODEL_LIMIT),
    // Both sources always show, even when one is empty.
    sources: [...sources.entries()].map(([label, tally]) => ({
      label,
      tokens: tally.tokens,
      share: tokens > 0 ? tally.tokens / tokens : 0,
    })),
    projects: rowsOf(projects, tokens, PROJECT_LIMIT),
  }
}

// Every window of the report, from every chat's saved counts.
export function buildReport(sessions: readonly Session[], now: number): Report {
  return { at: now, sections: WINDOWS.map(({ title, ms }) => sectionOf(sessions, now, title, ms)) }
}

// Whether there is nothing to show in any window.
export const isEmpty = (report: Report) => report.sections.every(section => section.tokens === 0)

// 1.2M, 340k, 950: three significant figures at most.
export function compact(tokens: number) {
  const n = Math.max(0, Math.round(tokens))

  if (n < 1000) {
    return String(n)
  }

  const one = (value: number) => (value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value)))

  if (n < 999_500) {
    return `${one(n / 1000)}k`
  }

  return n < 999_500_000 ? `${one(n / 1e6)}M` : `${one(n / 1e9)}B`
}

export function percent(share: number) {
  if (share <= 0) {
    return '0%'
  }

  return share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`
}

const PARTS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉']

// A bar `width` cells wide for a share of 0 to 1, in eighths of a cell; any
// share above nothing shows at least a sliver.
export function bar(share: number, width: number) {
  if (width <= 0 || share <= 0) {
    return ''
  }

  const eighths = Math.min(width * 8, Math.max(1, Math.round(share * width * 8)))
  const part = eighths % 8

  return '█'.repeat(Math.floor(eighths / 8)) + (part > 0 ? (PARTS[part - 1] ?? '') : '')
}

export type Layout = { label: number; bar: number }

const PCT_WIDTH = 4
const TOKENS_WIDTH = 5
const COLUMN_GAPS = 3
const MIN_LABEL = 6
const MAX_LABEL = 16

// Splits a row's width into the label and the bar; the percentage and the tokens are fixed.
export function layoutOf(columns: number, longest: number): Layout {
  const fixed = PCT_WIDTH + TOKENS_WIDTH + COLUMN_GAPS
  const label = Math.min(MAX_LABEL, Math.max(MIN_LABEL, longest))
  const room = columns - fixed - label

  if (room >= 6) {
    return { label, bar: room }
  }

  return { label: MIN_LABEL, bar: Math.max(0, columns - fixed - MIN_LABEL) }
}

export const widths = { percent: PCT_WIDTH, tokens: TOKENS_WIDTH }

export const FOOTNOTE =
  'Shares of tokens, not of your limits: Opus uses more of your limits per token than Sonnet. Cache reads are left out.'

export const EMPTY = 'Nothing recorded yet: counting starts now.'
