import { expect, test } from 'claude-code/testing'

import { briefDetailsOf, compactTokens, contextDetailsOf, detailsOf, fitting, isReading, labelOf, paceOf, thresholdOf, timeUntil, viewOf } from './format'
import type { Segment } from './format'
import { meterRuns, meterSvg } from './meter'

const NOW = Date.parse('2026-10-07T12:00:00Z')

test('names each window', async () => {
  expect(labelOf('five_hour')).toBe('5-hour')
  expect(labelOf('seven_day')).toBe('Weekly')
  expect(labelOf('seven_day_opus')).toBe('Weekly · Opus')
  expect(labelOf('spend_limit')).toBe('Spend')
  expect(labelOf('some_new_window')).toBe('Some new window')
})

test('counts down in days, hours and minutes, never below zero', async () => {
  expect(timeUntil('2026-10-07T14:14:00Z', NOW)).toBe('2h 14m')
  expect(timeUntil('2026-10-07T13:00:00Z', NOW)).toBe('1h')
  expect(timeUntil('2026-10-10T16:00:00Z', NOW)).toBe('3d 4h')
  expect(timeUntil('2026-10-07T12:45:00Z', NOW)).toBe('45m')
  expect(timeUntil('2026-10-07T11:00:00Z', NOW)).toBe('0m')
  expect(timeUntil(undefined, NOW)).toBe(undefined)
})

test('finds the highest threshold reached', async () => {
  expect(thresholdOf(79.9)).toBe(undefined)
  expect(thresholdOf(80)).toBe(80)
  expect(thresholdOf(97)).toBe(95)
})

test('projects nothing early in a window or without a known length', async () => {
  // Five minutes into a five-hour window.
  const early = paceOf({ kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-07T16:55:00Z' }, NOW)
  expect(early?.outlook).toBe('early')
  expect(paceOf({ kind: 'spend_limit', percentUsed: 30 }, NOW)).toBe(undefined)
})

test('says whether the window runs out before it resets', async () => {
  // Four of five hours gone, 62% used: 77.5% by the reset.
  const steady = paceOf({ kind: 'five_hour', percentUsed: 62, resetsAt: '2026-10-07T13:00:00Z' }, NOW)
  expect(steady?.outlook).toBe('on-track')
  expect(Math.round((steady?.elapsed ?? 0) * 100)).toBe(80)

  // Four of seven days gone, 85% used: out in about 17 hours, three days before the reset.
  const fast = paceOf({ kind: 'seven_day', percentUsed: 85, resetsAt: '2026-10-10T12:00:00Z' }, NOW)
  expect(fast?.outlook).toBe('limit')
  expect(Math.round((fast?.hitsLimitInMs ?? 0) / 60_000)).toBe(1016)
})

test('draws the terminal meter in half cells with the window mark', async () => {
  expect(meterRuns(10, 25)).toEqual([
    { text: '━━╸', role: 'fill' },
    { text: '───────', role: 'empty' },
  ])
  expect(meterRuns(10, 25, 0.5)).toEqual([
    { text: '━━╸', role: 'fill' },
    { text: '──', role: 'empty' },
    { text: '┼', role: 'mark-empty' },
    { text: '────', role: 'empty' },
  ])
  expect(meterRuns(10, 80, 0.5).map(run => run.role)).toEqual(['fill', 'mark-fill', 'fill', 'empty'])
  expect(meterRuns(4, 0)).toEqual([{ text: '────', role: 'empty' }])
  expect(meterRuns(4, 0.4)[0]).toEqual({ text: '╸', role: 'fill' })
})

test('draws the desktop meter at the width asked, the mark only with a window', async () => {
  const svg = meterSvg(200, 50, 0.25, '#3987e5', '#898781')
  expect(svg).toContain('width="200"')
  expect(svg).toContain('preserveAspectRatio="none"')
  expect(svg).toContain('width="100.0"')
  expect(svg).toContain('<rect x="49.0" width="2" height="9"')
  expect(meterSvg(200, 50, undefined, '#3987e5', '#898781')).not.toContain('<rect x=')
})

test('a fresh reading shows its forecast; a stale one shows its age instead', async () => {
  const limit = { kind: 'seven_day', percentUsed: 85, resetsAt: '2026-10-10T12:00:00Z' }
  const fresh = viewOf(limit, NOW, NOW - 60_000)
  expect(Math.round((fresh.forecastMs ?? 0) / 60_000)).toBe(1016)
  expect(fresh.age).toBe(undefined)

  const stale = viewOf(limit, NOW, NOW - 12 * 60_000)
  expect(stale.forecastMs).toBe(undefined)
  expect([stale.percent, stale.age, stale.resets]).toEqual([85, '12m', '3d'])
})

test('a window whose reset time has passed shows as reset', async () => {
  const limit = { kind: 'five_hour', percentUsed: 97, resetsAt: '2026-10-07T11:30:00Z' }
  expect(viewOf(limit, NOW, NOW - 3 * 3_600_000)).toEqual({ percent: 0, hasReset: true, age: '3h', resetAgo: '30m' })
})

test('only well-formed saved readings are used', async () => {
  expect(isReading({ limits: [{ kind: 'five_hour', percentUsed: 1 }], at: 1 })).toBe(true)
  expect(isReading(undefined)).toBe(false)
  expect(isReading({ limits: [{ kind: 'five_hour' }], at: 1 })).toBe(false)
  expect(isReading({ limits: 'x', at: 1 })).toBe(false)
  expect(isReading({ limits: [] })).toBe(false)
})

test('writes token counts the way people say them', async () => {
  expect([950, 82_000, 82_499, 1_000_000, 1_240_000].map(compactTokens)).toEqual(['950', '82k', '82k', '1M', '1.2M'])
})

const textOf = (segments: readonly Segment[]) => segments.map(segment => segment.text).join('')

test('a detail sheds the reading\'s age, then the reset, to fit beside its figure', async () => {
  const stale = detailsOf({ percent: 47, elapsed: 0.8, resets: '1h 7m', age: '2m', hasReset: false })
  expect(stale.map(textOf)).toEqual(['as of 2m ago · resets in 1h 7m', 'resets in 1h 7m'])
  expect(textOf(fitting(stale, 40))).toBe('as of 2m ago · resets in 1h 7m')
  expect(textOf(fitting(stale, 18))).toBe('resets in 1h 7m')
  expect(fitting(stale, 10)).toEqual([])
})

test('a forecast keeps its warning longest, down to the bare time', async () => {
  const details = detailsOf({ percent: 85, elapsed: 0.6, forecastMs: 1016 * 60_000, resets: '3d', hasReset: false })
  expect(details.map(textOf)).toEqual(['→ limit in ~16h 56m · resets in 3d', '→ limit in ~16h 56m', '→ ~16h 56m'])
  expect(fitting(details, 12).map(segment => segment.tone)).toEqual(['warning', 'plain'])
})

test('a reached limit says when it comes back before anything else goes', async () => {
  const details = detailsOf({ percent: 100, resets: '42m', age: '5m', hasReset: false })
  expect(details.map(textOf)).toEqual(['Limit reached · as of 5m ago · resets in 42m', 'Limit reached · resets in 42m', 'resets in 42m'])
  expect(detailsOf({ percent: 0, age: '3h', hasReset: true, resetAgo: '2h' }).map(textOf)).toEqual(['reset 2h ago', 'reset'])
  expect(detailsOf({ percent: 0, hasReset: true, resetAgo: '0m' }).map(textOf)).toEqual(['reset just now', 'reset'])
})

test('the context detail falls back to the token count alone', async () => {
  expect(contextDetailsOf({ percent: 74, tokens: 735_000, window: 1_000_000 }).map(textOf)).toEqual(['735k of 1M', '735k'])
})

test('the desktop gets one fact per figure: the forecast, the reset or when the limit comes back', async () => {
  const stale = { percent: 47, elapsed: 0.8, resets: '1h 7m', age: '11m', hasReset: false }
  expect(briefDetailsOf(stale).map(textOf)).toEqual(['resets in 1h 7m'])
  const forecast = { percent: 85, elapsed: 0.6, forecastMs: 1016 * 60_000, resets: '3d', hasReset: false }
  expect(briefDetailsOf(forecast).map(textOf)).toEqual(['→ limit in ~16h 56m', '→ ~16h 56m'])
  expect(briefDetailsOf({ percent: 100, resets: '42m', age: '5m', hasReset: false }).map(textOf)).toEqual(['resets in 42m'])
  expect(briefDetailsOf({ percent: 0, hasReset: true, resetAgo: '2h' }).map(textOf)).toEqual(['reset 2h ago', 'reset'])
})
