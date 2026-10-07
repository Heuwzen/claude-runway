import type { Level } from '../types'

const MINUTE = 60_000

// Longest the status line may be, so it never wraps under the prompt.
export const MAX_STATUS = 80

export type Change = { code: string; path: string }

export type Commit = {
  // Milliseconds since the epoch.
  at: number
  subject: string
}

export type Snapshot = {
  changes: Change[]
  added: number
  removed: number
  last?: Commit
}

// Thresholds of the two nudge levels.
const LEVEL_1 = { ageMs: 30 * MINUTE, lines: 150, files: 8 }
const LEVEL_2 = { ageMs: 90 * MINUTE, lines: 600, files: 25 }

// Entries of `git status --porcelain=v1 -z`: "XY path", NUL-ended, a rename or
// copy followed by one more field holding where it came from.
export function parseStatus(stdout: string): Change[] {
  const fields = stdout.split('\0')
  const changes: Change[] = []

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]

    if (field === undefined || field.length < 4) {
      continue
    }

    const code = field.slice(0, 2)
    changes.push({ code, path: field.slice(3) })

    if (code.includes('R') || code.includes('C')) {
      i++
    }
  }

  return changes
}

// " 3 files changed, 420 insertions(+), 38 deletions(-)", either part possibly missing.
export function parseShortstat(stdout: string) {
  const count = (pattern: RegExp) => Number(pattern.exec(stdout)?.[1] ?? 0)

  return { added: count(/(\d+) insertions?\(\+\)/), removed: count(/(\d+) deletions?\(-\)/) }
}

// "<unix seconds>\t<subject>", or nothing when the repository has no commit.
export function parseLog(stdout: string): Commit | undefined {
  const line = stdout.replace(/\r?\n$/, '')
  const tab = line.indexOf('\t')
  const seconds = Number(tab < 0 ? line : line.slice(0, tab))

  if (line === '' || Number.isNaN(seconds)) {
    return undefined
  }

  return { at: seconds * 1000, subject: tab < 0 ? '' : line.slice(tab + 1) }
}

export const linesOf = (snap: Snapshot) => snap.added + snap.removed

// Level 2 counts only a real commit's age: a new repository with one file is not overdue.
export function levelOf(snap: Snapshot, now: number): Level {
  const files = snap.changes.length

  if (files === 0) {
    return 0
  }

  const lines = linesOf(snap)
  const ageMs = snap.last === undefined ? Infinity : now - snap.last.at

  if (
    (snap.last !== undefined && ageMs >= LEVEL_2.ageMs) ||
    lines >= LEVEL_2.lines ||
    files >= LEVEL_2.files
  ) {
    return 2
  }

  return ageMs >= LEVEL_1.ageMs && (lines >= LEVEL_1.lines || files >= LEVEL_1.files) ? 1 : 0
}

export type Notified = { notified: Level; seen: number }

// What to toast after a measurement. The toast is armed again once the tree is
// clean or a new commit has landed, and not otherwise: a level that falls and
// comes back does not toast twice.
export function stepOf(prev: Notified, level: Level, files: number, commitAt: number) {
  const isRearmed = files === 0 || commitAt !== prev.seen
  const base = isRearmed ? 0 : prev.notified

  return { notified: base > level ? base : level, seen: commitAt, shouldToast: level > base }
}

export const commitAtSeconds = (snap: Snapshot) => (snap.last === undefined ? 0 : Math.round(snap.last.at / 1000))

export function formatAge(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE)

  if (minutes < 1) {
    return '<1 min'
  }

  if (minutes < 60) {
    return `${minutes} min`
  }

  const hours = Math.floor(minutes / 60)

  if (hours < 24) {
    return minutes % 60 > 0 ? `${hours} h ${minutes % 60} min` : `${hours} h`
  }

  const days = Math.floor(hours / 24)

  return hours % 24 > 0 ? `${days} d ${hours % 24} h` : `${days} d`
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export function projectOf(top: string) {
  return top.split('/').filter(Boolean).at(-1) ?? 'repo'
}

function shorten(text: string, room: number) {
  return text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`
}

// "NoteOS: 14 files, +420 −38 uncommitted · last commit 52 min ago", cut to fit.
export function statusOf(project: string, snap: Snapshot, now: number) {
  const body = `${plural(snap.changes.length, 'file')}, +${snap.added} −${snap.removed} uncommitted`
  const age = snap.last === undefined ? undefined : formatAge(now - snap.last.at)
  const tail = age === undefined ? 'no commit yet' : `last commit ${age} ago`
  const make = (name: string, end: string) => `${name}: ${body} · ${end}`
  const full = make(project, tail)

  if (full.length <= MAX_STATUS) {
    return full
  }

  const room = MAX_STATUS - (full.length - project.length)

  if (room >= 4) {
    return make(shorten(project, room), tail)
  }

  // A very long figure: drop the name's room and the tail's words before cutting.
  const compact = `${body} · ${age === undefined ? 'no commit' : `${age} ago`}`

  return shorten(compact, MAX_STATUS)
}

export function toastOf(project: string, snap: Snapshot, now: number) {
  const files = `${plural(snap.changes.length, 'uncommitted file')}`
  const lines = snap.added > 0 ? ` (+${snap.added} lines)` : snap.removed > 0 ? ` (−${snap.removed} lines)` : ''

  if (snap.last === undefined) {
    return `${project}: ${files}${lines} and no commit yet.`
  }

  const ageMs = now - snap.last.at
  const end = ageMs >= LEVEL_1.ageMs ? `no commit for ${formatAge(ageMs)}` : `the last commit was ${formatAge(ageMs)} ago`

  return `${project}: ${files}${lines} and ${end}.`
}

const pad = (value: number) => String(value).padStart(2, '0')

// Local time, "2026-10-07 14:05".
export function formatClock(ms: number) {
  const date = new Date(ms)

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const LISTED = 15
const SUBJECT_MAX = 100

// The /commit-nudge answer.
export function detailsOf(project: string, snap: Snapshot, now: number) {
  const files = snap.changes.length
  const level = levelOf(snap, now)
  const rows: string[] = []

  if (files === 0) {
    rows.push(`${project}: nothing uncommitted.`)
  } else {
    rows.push(`${project}: ${plural(files, 'changed file')}, +${snap.added} −${snap.removed} lines in tracked files.`)

    for (const change of snap.changes.slice(0, LISTED)) {
      rows.push(`  ${change.code} ${change.path}`)
    }

    if (files > LISTED) {
      rows.push(`  and ${files - LISTED} more`)
    }
  }

  if (snap.last === undefined) {
    rows.push('Last commit: none yet.')
  } else {
    const subject = snap.last.subject === '' ? '' : ` "${shorten(snap.last.subject, SUBJECT_MAX)}"`
    rows.push(`Last commit: ${formatAge(now - snap.last.at)} ago (${formatClock(snap.last.at)})${subject}`)
  }

  rows.push(level === 0 ? 'Nudge: none.' : `Nudge: level ${level}.`)

  return rows.join('\n')
}
