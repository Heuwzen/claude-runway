import { expect, test } from 'claude-code/testing'

import type { Hours, Session } from '../types'
import {
  HOUR,
  addRequest,
  bar,
  basename,
  buildReport,
  compact,
  hourOf,
  isEmpty,
  isSession,
  layoutOf,
  modelLabel,
  percent,
  projectOf,
  pruneHours,
  sweepPlan,
} from './format'

const NOW = Date.parse('2026-10-07T12:30:00Z')
const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 30 }

const session = (project: string, hours: Session['hours'], updatedAt = NOW): Session => ({ project, updatedAt, hours })

test('names models briefly', async () => {
  expect(modelLabel('claude-opus-4-5-20251101')).toBe('Opus 4.5')
  expect(modelLabel('claude-opus-4-20250514')).toBe('Opus 4')
  expect(modelLabel('claude-sonnet-4-5')).toBe('Sonnet 4.5')
  expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  expect(modelLabel('claude-3-opus-20240229')).toBe('Opus 3')
  expect(modelLabel('claude-opus-4-5[1m]')).toBe('Opus 4.5')
  expect(modelLabel('claude-haiku')).toBe('Haiku')
  expect(modelLabel('some-model')).toBe('some-model')
  expect(modelLabel('')).toBe('unknown')
})

test('takes the project from the git top level, else the working folder', async () => {
  expect(basename('/Users/me/code/app/')).toBe('app')
  expect(projectOf('/Users/me/code/app/src', '/Users/me/code/app\n')).toBe('app')
  expect(projectOf('/Users/me/code/app/src', undefined)).toBe('src')
  expect(projectOf('/Users/me/code/app/src', '')).toBe('src')
  expect(projectOf('/', undefined)).toBe('/')
})

test('adds a request to its hour without changing the hours before it', async () => {
  const first = addRequest({}, NOW, 'claude-opus-4-5', 'main', USAGE)
  const second = addRequest(first, NOW + 60_000, 'claude-opus-4-5', 'main', USAGE)
  const start = String(hourOf(NOW))

  // Requests, input, cache write, cache read, output.
  expect(first[start]).toEqual({ 'claude-opus-4-5|main': [1, 10, 30, 1000, 20] })
  expect(second[start]).toEqual({ 'claude-opus-4-5|main': [2, 20, 60, 2000, 40] })
  expect(first[start]).toEqual({ 'claude-opus-4-5|main': [1, 10, 30, 1000, 20] })

  const agent = addRequest(second, NOW + HOUR, 'claude-opus-4-5', 'agents', USAGE)
  expect(Object.keys(agent)).toHaveLength(2)
})

test('counts a missing or odd number as zero', async () => {
  const hours = addRequest({}, NOW, 'm', 'main', {
    input_tokens: Number.NaN,
    output_tokens: -5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 7,
  })
  expect(hours[String(hourOf(NOW))]).toEqual({ 'm|main': [1, 0, 7, 0, 0] })
})

test('prunes hours older than 8 days', async () => {
  const old = String(hourOf(NOW - 9 * 24 * HOUR))
  const recent = String(hourOf(NOW - 7 * 24 * HOUR))
  const kept = pruneHours({ [old]: {}, [recent]: {} }, NOW)
  expect(Object.keys(kept)).toEqual([recent])
})

test('recognizes a saved chat and nothing else', async () => {
  expect(isSession(session('app', { '1': { 'm|main': [1, 2, 3, 4, 5] } }))).toBe(true)
  expect(isSession(session('app', {}))).toBe(true)
  expect(isSession(null)).toBe(false)
  expect(isSession({ project: 'app', updatedAt: 1 })).toBe(false)
  expect(isSession(session('app', { '1': { 'm|main': [1, 2, 3] } } as never))).toBe(false)
})

test('sweeps old and unreadable chats, never the own one', async () => {
  const fresh = session('app', {})
  const old = session('app', {}, NOW - 9 * 24 * HOUR)
  const plan = sweepPlan(
    [
      { key: 'session:fresh', value: fresh },
      { key: 'session:old', value: old },
      { key: 'session:own', value: old },
      { key: 'session:broken', value: { nope: true } },
      { key: 'other', value: old },
    ],
    NOW,
    'session:own',
  )
  expect(plan.sort()).toEqual(['session:broken', 'session:old'])
})

test('sweeps the least recently updated chats when the store grows large', async () => {
  const hours: Session['hours'] = {}

  for (let i = 0; i < 8000; i++) {
    hours[String(i)] = { 'claude-opus-4-5|main': [1, 2, 3, 4, 5] }
  }

  const entries = [0, 1, 2, 3, 4, 5, 6, 7].map(i => ({
    key: `session:${i}`,
    value: session('app', hours, NOW - i * HOUR),
  }))
  const plan = sweepPlan(entries, NOW, 'session:none')
  // The oldest go first.
  expect(plan.length).toBeGreaterThan(0)
  expect(plan[0]).toBe('session:7')
  expect(plan).not.toContain('session:0')
})

test('builds shares of tokens by model, source and project, leaving out cache reads', async () => {
  const hour = String(hourOf(NOW))
  const sessions = [
    session('app', {
      [hour]: {
        'claude-opus-4-5-20251101|main': [2, 100, 200, 99999, 300],
        'claude-opus-4-5|agents': [1, 100, 0, 5000, 100],
      },
    }),
    session('site', { [hour]: { 'claude-sonnet-4-5|main': [1, 100, 0, 0, 100] } }),
  ]
  const [five, week] = buildReport(sessions, NOW).sections

  expect(five?.title).toBe('Last 5 hours')
  expect(week?.title).toBe('Last 7 days')
  // 600 + 200 + 200 tokens.
  expect(five?.tokens).toBe(1000)
  expect(five?.requests).toBe(4)
  expect(five?.models).toEqual([
    { label: 'Opus 4.5', tokens: 800, share: 0.8 },
    { label: 'Sonnet 4.5', tokens: 200, share: 0.2 },
  ])
  expect(five?.sources).toEqual([
    { label: 'Main chats', tokens: 800, share: 0.8 },
    { label: 'Agents', tokens: 200, share: 0.2 },
  ])
  expect(five?.projects.map(row => row.label)).toEqual(['app', 'site'])
})

test('puts hours into the windows they overlap', async () => {
  const hours: Hours = {
    [String(hourOf(NOW - 4 * HOUR))]: { 'm|main': [1, 100, 0, 0, 0] },
    [String(hourOf(NOW - 6 * HOUR))]: { 'm|main': [1, 10, 0, 0, 0] },
    [String(hourOf(NOW - 6 * 24 * HOUR))]: { 'm|main': [1, 1, 0, 0, 0] },
    [String(hourOf(NOW - 7 * 24 * HOUR - HOUR))]: { 'm|main': [1, 1000, 0, 0, 0] },
  }
  const [five, week] = buildReport([session('app', hours)], NOW).sections
  expect(five?.tokens).toBe(100)
  expect(week?.tokens).toBe(111)
})

test('folds projects past the sixth into Other', async () => {
  const hour = String(hourOf(NOW))
  const sessions = [1, 2, 3, 4, 5, 6, 7, 8].map(i => session(`p${i}`, { [hour]: { 'm|main': [1, i * 10, 0, 0, 0] } }))
  const projects = buildReport(sessions, NOW).sections[0]?.projects ?? []
  expect(projects.map(row => row.label)).toEqual(['p8', 'p7', 'p6', 'p5', 'p4', 'p3', 'Other'])
  expect(projects.at(-1)?.tokens).toBe(30)
  expect(Math.abs(projects.reduce((sum, row) => sum + row.share, 0) - 1)).toBeLessThan(1e-9)
})

test('is empty until something is counted', async () => {
  expect(isEmpty(buildReport([], NOW))).toBe(true)
  expect(isEmpty(buildReport([session('app', { [String(hourOf(NOW))]: { 'm|main': [1, 5, 0, 0, 0] } })], NOW))).toBe(false)
})

test('writes tokens compactly', async () => {
  expect(compact(0)).toBe('0')
  expect(compact(950)).toBe('950')
  expect(compact(1200)).toBe('1.2k')
  expect(compact(10_000)).toBe('10k')
  expect(compact(340_000)).toBe('340k')
  expect(compact(999_600)).toBe('1M')
  expect(compact(1_200_000)).toBe('1.2M')
  expect(compact(48_000_000)).toBe('48M')
  expect(compact(2_400_000_000)).toBe('2.4B')
})

test('writes shares as whole percents, with a floor for a sliver', async () => {
  expect(percent(0)).toBe('0%')
  expect(percent(0.004)).toBe('<1%')
  expect(percent(0.456)).toBe('46%')
  expect(percent(1)).toBe('100%')
})

test('draws bars in eighths of a cell', async () => {
  expect(bar(1, 10)).toBe('██████████')
  expect(bar(0.5, 10)).toBe('█████')
  expect(bar(0.25, 10)).toBe('██▌')
  expect(bar(0.001, 10)).toBe('▏')
  expect(bar(0, 10)).toBe('')
  expect(bar(1, 0)).toBe('')
})

test('gives the bar what the label and figures leave', async () => {
  expect(layoutOf(100, 10)).toEqual({ label: 10, bar: 78 })
  expect(layoutOf(100, 40)).toEqual({ label: 16, bar: 72 })
  expect(layoutOf(30, 12)).toEqual({ label: 12, bar: 6 })
  expect(layoutOf(26, 12)).toEqual({ label: 6, bar: 8 })
  expect(layoutOf(12, 12)).toEqual({ label: 6, bar: 0 })
})
