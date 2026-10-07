import type { Limit, Reading } from '../types'

const HOUR = 3_600_000

const LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  spend_limit: 'Spend',
}

export const THRESHOLDS = [80, 95]

export type Severity = 'normal' | 'warning' | 'critical'

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export function labelOf(kind: string) {
  const label = LABELS[kind]

  if (label !== undefined) {
    return label
  }

  // Per-model weekly windows, such as seven_day_opus.
  if (kind.startsWith('seven_day_')) {
    return `Weekly · ${capitalize(kind.slice('seven_day_'.length))}`
  }

  return capitalize(kind.replaceAll('_', ' '))
}

// How long a window runs, where the kind says; a spend limit has no fixed length.
export function windowMsOf(kind: string) {
  if (kind === 'five_hour') {
    return 5 * HOUR
  }

  return kind === 'seven_day' || kind.startsWith('seven_day_') ? 7 * 24 * HOUR : undefined
}

export function formatDuration(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  }

  if (hours > 0) {
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
  }

  return `${rest}m`
}

export function timeUntil(resetsAt: string | undefined, now: number) {
  return resetsAt === undefined ? undefined : formatDuration(Date.parse(resetsAt) - now)
}

export const severityOf = (percentUsed: number): Severity =>
  percentUsed >= 95 ? 'critical' : percentUsed >= 80 ? 'warning' : 'normal'

// The highest threshold a window has reached, or undefined below the first.
export const thresholdOf = (percentUsed: number) =>
  THRESHOLDS.filter(threshold => percentUsed >= threshold).at(-1)

export type Pace = {
  // How far through its window the clock is, 0 to 1.
  elapsed: number
  // `early`: too soon, or too little used, to project. `limit`: at the average
  // rate so far the window runs out `hitsLimitInMs` from now, before it resets.
  outlook: 'early' | 'on-track' | 'limit'
  hitsLimitInMs?: number
}

export function paceOf(limit: Limit, now: number): Pace | undefined {
  const windowMs = windowMsOf(limit.kind)
  const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)

  if (windowMs === undefined || Number.isNaN(resetsAt)) {
    return undefined
  }

  const remainingMs = Math.max(0, resetsAt - now)
  const elapsedMs = Math.min(windowMs, windowMs - remainingMs)
  const elapsed = elapsedMs / windowMs

  if (elapsed < 0.1 || limit.percentUsed < 5 || limit.percentUsed >= 100) {
    return { elapsed, outlook: 'early' }
  }

  const hitsLimitInMs = ((100 - limit.percentUsed) / limit.percentUsed) * elapsedMs

  return hitsLimitInMs < remainingMs
    ? { elapsed, outlook: 'limit', hitsLimitInMs }
    : { elapsed, outlook: 'on-track' }
}

// Token counts as people say them: 950, 82k, 1.2M.
export function compactTokens(count: number) {
  if (count < 1000) {
    return String(count)
  }

  if (count < 1_000_000) {
    return `${Math.round(count / 1000)}k`
  }

  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

// A reading older than this is shown with its age, and without a forecast.
export const STALE_AFTER = 2 * 60_000

export type LimitView = {
  // What the figure and the meter show: 0 once the window has reset since the reading.
  percent: number
  // How far through its window the clock is, for the meter's mark.
  elapsed?: number
  // How long until the window runs out at this pace, when that comes before the reset.
  forecastMs?: number
  // The time left until the window resets, as text.
  resets?: string
  // How old the reading is, as text, once it is stale.
  age?: string
  hasReset: boolean
}

// What one window looks like now, from a reading taken at `readingAt`.
export function viewOf(limit: Limit, now: number, readingAt: number): LimitView {
  const resetAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
  const age = readingAt > 0 && now - readingAt >= STALE_AFTER ? formatDuration(now - readingAt) : undefined

  if (resetAt <= now) {
    return { percent: 0, hasReset: true, age }
  }

  const pace = paceOf(limit, now)

  return {
    percent: limit.percentUsed,
    elapsed: pace?.elapsed,
    forecastMs: age === undefined && pace?.outlook === 'limit' ? pace.hitsLimitInMs : undefined,
    resets: timeUntil(limit.resetsAt, now),
    age,
    hasReset: false,
  }
}

// Whether a value read back from the store is a reading this mod saved.
export function isReading(value: unknown): value is Reading {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const { limits, at } = value as Partial<Reading>

  return typeof at === 'number' && Array.isArray(limits) && limits.every(
    limit => typeof limit === 'object' && limit !== null
      && typeof limit.kind === 'string' && typeof limit.percentUsed === 'number',
  )
}
