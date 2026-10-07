import { expect, test } from 'claude-code/testing'

import {
  detailsOf,
  formatAge,
  levelOf,
  MAX_STATUS,
  parseLog,
  parseShortstat,
  parseStatus,
  projectOf,
  statusOf,
  stepOf,
  toastOf,
} from './format'
import type { Snapshot } from './format'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const MIN = 60_000

// A snapshot of `files` changed files and the given lines, last committed `ago` minutes back.
function snapOf(files: number, added: number, removed: number, ago?: number): Snapshot {
  return {
    changes: Array.from({ length: files }, (_, i) => ({ code: ' M', path: `src/file${i}.ts` })),
    added,
    removed,
    last: ago === undefined ? undefined : { at: NOW - ago * MIN, subject: 'Add the thing' },
  }
}

test('reads changed and untracked files from the NUL-separated status', async () => {
  expect(parseStatus(' M a.ts\0?? new dir/\0A  b.ts\0')).toEqual([
    { code: ' M', path: 'a.ts' },
    { code: '??', path: 'new dir/' },
    { code: 'A ', path: 'b.ts' },
  ])
  expect(parseStatus('')).toEqual([])
})

test('a rename counts once, its source field skipped', async () => {
  const changes = parseStatus('R  new.ts\0old.ts\0 M other.ts\0')
  expect(changes).toEqual([
    { code: 'R ', path: 'new.ts' },
    { code: ' M', path: 'other.ts' },
  ])
})

test('reads lines from the short stat, whichever parts it has', async () => {
  expect(parseShortstat(' 3 files changed, 420 insertions(+), 38 deletions(-)\n')).toEqual({ added: 420, removed: 38 })
  expect(parseShortstat(' 1 file changed, 1 insertion(+)\n')).toEqual({ added: 1, removed: 0 })
  expect(parseShortstat(' 1 file changed, 2 deletions(-)\n')).toEqual({ added: 0, removed: 2 })
  expect(parseShortstat('')).toEqual({ added: 0, removed: 0 })
})

test('reads the last commit, with a tab inside the subject kept', async () => {
  expect(parseLog('1790000000\tFix the sync\n')).toEqual({ at: 1_790_000_000_000, subject: 'Fix the sync' })
  expect(parseLog('1790000000\tA\tB\n')?.subject).toBe('A\tB')
  expect(parseLog('')).toBe(undefined)
  expect(parseLog('not a time\tx')).toBe(undefined)
})

test('level 1 needs a dirty tree, a commit 30 minutes old and 150 lines or 8 files', async () => {
  expect(levelOf(snapOf(0, 0, 0, 60), NOW)).toBe(0)
  expect(levelOf(snapOf(8, 0, 0, 29), NOW)).toBe(0)
  expect(levelOf(snapOf(8, 0, 0, 30), NOW)).toBe(1)
  expect(levelOf(snapOf(7, 100, 49, 45), NOW)).toBe(0)
  expect(levelOf(snapOf(7, 100, 50, 45), NOW)).toBe(1)
  expect(levelOf(snapOf(3, 10, 5, 89), NOW)).toBe(0)
})

test('level 2 at a commit 90 minutes old, 600 lines or 25 files', async () => {
  expect(levelOf(snapOf(1, 1, 0, 90), NOW)).toBe(2)
  expect(levelOf(snapOf(1, 1, 0, 89), NOW)).toBe(0)
  expect(levelOf(snapOf(2, 400, 200, 1), NOW)).toBe(2)
  expect(levelOf(snapOf(25, 0, 0, 1), NOW)).toBe(2)
  expect(levelOf(snapOf(24, 0, 0, 1), NOW)).toBe(0)
})

test('a new repository counts as old for level 1 but not for level 2', async () => {
  expect(levelOf(snapOf(1, 0, 0), NOW)).toBe(0)
  expect(levelOf(snapOf(8, 0, 0), NOW)).toBe(1)
  expect(levelOf(snapOf(25, 0, 0), NOW)).toBe(2)
})

test('toasts on entering a level, once, until a clean tree or a new commit', async () => {
  const first = stepOf({ notified: 0, seen: 5 }, 1, 14, 5)
  expect(first).toEqual({ notified: 1, seen: 5, shouldToast: true })
  expect(stepOf(first, 1, 14, 5).shouldToast).toBe(false)

  const second = stepOf(first, 2, 14, 5)
  expect(second.shouldToast).toBe(true)
  // The level falling back and rising again does not toast twice.
  expect(stepOf(stepOf(second, 0, 3, 5), 2, 14, 5).shouldToast).toBe(false)

  // A clean tree re-arms, and so does a new commit.
  expect(stepOf(stepOf(second, 0, 0, 5), 1, 9, 5).shouldToast).toBe(true)
  expect(stepOf(second, 1, 9, 6).shouldToast).toBe(true)
})

test('writes ages in minutes, hours and days', async () => {
  expect(formatAge(20_000)).toBe('<1 min')
  expect(formatAge(52 * MIN)).toBe('52 min')
  expect(formatAge(120 * MIN)).toBe('2 h')
  expect(formatAge(135 * MIN)).toBe('2 h 15 min')
  expect(formatAge(52 * 60 * MIN)).toBe('2 d 4 h')
  expect(formatAge(48 * 60 * MIN)).toBe('2 d')
  expect(formatAge(-5 * MIN)).toBe('<1 min')
})

test('names the project by its folder', async () => {
  expect(projectOf('/Users/arda/code/NoteOS')).toBe('NoteOS')
  expect(projectOf('/Users/arda/code/NoteOS/')).toBe('NoteOS')
  expect(projectOf('/')).toBe('repo')
})

test('the status line and the toast match the examples', async () => {
  const snap = snapOf(14, 420, 38, 52)
  expect(statusOf('NoteOS', snap, NOW)).toBe('NoteOS: 14 files, +420 −38 uncommitted · last commit 52 min ago')
  expect(toastOf('NoteOS', snap, NOW)).toBe('NoteOS: 14 uncommitted files (+420 lines) and no commit for 52 min.')
})

test('the toast copes with one file, no added lines, a fresh commit and no commit', async () => {
  expect(toastOf('A', snapOf(1, 0, 7, 60), NOW)).toBe('A: 1 uncommitted file (−7 lines) and no commit for 1 h.')
  expect(toastOf('A', snapOf(30, 0, 0, 5), NOW)).toBe('A: 30 uncommitted files and the last commit was 5 min ago.')
  expect(toastOf('A', snapOf(9, 12, 0), NOW)).toBe('A: 9 uncommitted files (+12 lines) and no commit yet.')
  expect(statusOf('A', snapOf(9, 12, 0), NOW)).toBe('A: 9 files, +12 −0 uncommitted · no commit yet')
})

test('the status line stays under 80 characters by shortening the project name', async () => {
  const snap = snapOf(14, 420, 38, 52)
  const text = statusOf('A-very-long-project-folder-name-indeed-yes-it-is', snap, NOW)
  expect(text.length).toBeLessThanOrEqual(MAX_STATUS)
  expect(text).toMatch(/^A-very-long-project-fo…: 14 files, \+420 −38 uncommitted · last commit 52 min ago$/)
})

test('the status line never passes 80 characters, however long the figures or the name', async () => {
  for (const name of ['x', 'NoteOS', 'n'.repeat(40), 'n'.repeat(200)]) {
    for (const snap of [snapOf(14, 420, 38, 52), snapOf(123_456, 98_765_432, 87_654_321, 60 * 24 * 400), snapOf(5, 1, 1)]) {
      expect(statusOf(name, snap, NOW).length).toBeLessThanOrEqual(MAX_STATUS)
    }
  }
})

test('the details list up to 15 paths and count the rest', async () => {
  const text = detailsOf('NoteOS', snapOf(18, 420, 38, 52), NOW)
  const rows = text.split('\n')
  expect(rows[0]).toBe('NoteOS: 18 changed files, +420 −38 lines in tracked files.')
  expect(rows.filter(row => row.startsWith('   M src/'))).toHaveLength(15)
  expect(text).toContain('  and 3 more')
  expect(text).not.toContain('file15.ts')
  expect(text).toMatch(/Last commit: 52 min ago \(\d{4}-\d\d-\d\d \d\d:\d\d\) "Add the thing"/)
  expect(rows.at(-1)).toBe('Nudge: level 1.')
})

test('the details of a clean tree and of a repository without a commit', async () => {
  expect(detailsOf('NoteOS', snapOf(0, 0, 0, 5), NOW)).toContain('NoteOS: nothing uncommitted.')
  const fresh = detailsOf('NoteOS', snapOf(2, 0, 0), NOW)
  expect(fresh).toContain('Last commit: none yet.')
  expect(fresh).toContain('Nudge: none.')
})
