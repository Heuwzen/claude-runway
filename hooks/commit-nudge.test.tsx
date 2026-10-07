import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const MIN = 60_000
const CWD = '/work/NoteOS/app'
const TOP = '/work/NoteOS'

// What the fake repository answers; a test changes it between measurements.
type World = {
  isRepo: boolean
  // Git cannot be run at all.
  isDown?: boolean
  status: string
  shortstat: string
  // Minutes before NOW of the last commit; undefined for a repository with none.
  commitAgo?: number
}

const files = (count: number) => Array.from({ length: count }, (_, i) => ` M src/file${i}.ts\0`).join('')
const stat = (added: number, removed: number) =>
  ` 3 files changed, ${added} insertions(+), ${removed} deletions(-)\n`
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const fail = () => ({ exitCode: 128, stdout: '', stderr: 'fatal', isStdoutTruncated: false, isStderrTruncated: false })

// Stands in for the engine beneath the plugin: its clock, a git answering from
// `world`, its toasts and status line, and the commands the mod registers.
function engine(on: On, world: World) {
  const clock = mock.clock(on, { now: NOW })
  const toasts: { text: string; timeoutMs?: number }[] = []
  const statuses: (string | undefined)[] = []
  const calls: string[][] = []
  const registered: string[] = []

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('turn.complete', () => ({ text: 'done' }))
  on('command.register', (_, e) => {
    registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('ui.toast', (_, e) => {
    toasts.push({ text: e.text, timeoutMs: e.timeoutMs })

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    calls.push([...e.argv])

    if (world.isDown) {
      throw new Error('git is gone')
    }

    const [, , folder, sub] = e.argv

    if (sub === 'rev-parse') {
      return { value: world.isRepo ? ok(`${TOP}\n`) : fail() }
    }

    expect(folder).toBe(TOP)

    switch (sub) {
      case 'status':
        return { value: ok(world.status) }
      case 'diff':
        return { value: world.commitAgo === undefined ? fail() : ok(world.shortstat) }
      case 'log':
        return {
          value: world.commitAgo === undefined
            ? fail()
            : ok(`${Math.round((NOW - world.commitAgo * MIN) / 1000)}\tAdd the thing\n`),
        }
      default:
        throw new Error(`unexpected git command ${sub}`)
    }
  })

  return { clock, toasts, statuses, calls, registered }
}

const START = { cwd: CWD, surface: 'terminal', isInteractive: true } as const
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

const RUN = {
  command: 'commit-nudge',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

const BIG: World = { isRepo: true, status: files(14), shortstat: stat(420, 38), commitAgo: 52 }

test('nudges at level 1 with the status line and one toast', async ($, on) => {
  const { toasts, statuses, registered } = engine(on, { ...BIG })
  await $.session.start(START)

  expect(registered).toEqual(['commit-nudge'])
  expect(statuses.at(-1)).toBe('NoteOS: 14 files, +420 −38 uncommitted · last commit 52 min ago')
  expect(toasts).toEqual([
    { text: 'NoteOS: 14 uncommitted files (+420 lines) and no commit for 52 min.', timeoutMs: 10_000 },
  ])

  expect(await $.turn.complete(TURN)).toEqual({ text: 'done' })
  expect(toasts).toHaveLength(1)
})

test('stays quiet below the thresholds, and clears the line when the tree goes clean', async ($, on) => {
  const world: World = { ...BIG, status: files(3), shortstat: stat(20, 5), commitAgo: 60 }
  const { toasts, statuses } = engine(on, world)
  await $.session.start(START)
  expect(statuses.at(-1)).toBe(undefined)
  expect(toasts).toEqual([])

  Object.assign(world, BIG)
  await $.turn.complete(TURN)
  expect(statuses.at(-1)).toMatch(/^NoteOS: 14 files/)

  Object.assign(world, { status: '' })
  await $.turn.complete(TURN)
  expect(statuses.at(-1)).toBe(undefined)
})

test('toasts again on rising to level 2, then re-arms on a clean tree and on a new commit', async ($, on) => {
  const world: World = { ...BIG }
  const { toasts } = engine(on, world)
  await $.session.start(START)
  expect(toasts).toHaveLength(1)

  world.commitAgo = 95
  await $.turn.complete(TURN)
  expect(toasts.map(t => t.text)).toEqual([
    'NoteOS: 14 uncommitted files (+420 lines) and no commit for 52 min.',
    'NoteOS: 14 uncommitted files (+420 lines) and no commit for 1 h 35 min.',
  ])

  await $.turn.complete(TURN)
  expect(toasts).toHaveLength(2)

  // Clean, then dirty again.
  world.status = ''
  await $.turn.complete(TURN)
  world.status = files(9)
  await $.turn.complete(TURN)
  expect(toasts).toHaveLength(3)

  // A new commit lands, and the pile grows again.
  world.commitAgo = 40
  await $.turn.complete(TURN)
  expect(toasts).toHaveLength(4)
})

test('measures every 2 minutes, with the age moving on', async ($, on) => {
  const { clock, statuses, calls } = engine(on, { ...BIG, commitAgo: 50 })
  await $.session.start(START)
  expect(statuses.at(-1)).toMatch(/50 min ago$/)
  const before = calls.length

  await clock.advance(120_000)
  expect(calls.length).toBeGreaterThan(before)
  expect(statuses.at(-1)).toMatch(/52 min ago$/)

  await clock.advance(120_000)
  expect(statuses.at(-1)).toMatch(/54 min ago$/)
})

test('asks git with the exact read-only commands, and never a write', async ($, on) => {
  const { calls } = engine(on, { ...BIG })
  await $.session.start(START)

  expect(calls[0]).toEqual(['git', '-C', CWD, 'rev-parse', '--show-toplevel'])
  expect(calls).toContainEqual(['git', '-C', TOP, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'])
  expect(calls).toContainEqual(['git', '-C', TOP, 'diff', '--shortstat', 'HEAD'])
  expect(calls).toContainEqual(['git', '-C', TOP, 'log', '-1', '--format=%ct%x09%s'])
  expect(calls.every(call => ['rev-parse', 'status', 'diff', 'log'].includes(call[3] ?? ''))).toBe(true)
})

test('does nothing in a folder that is not a repository', async ($, on) => {
  const { clock, toasts, statuses, calls } = engine(on, { ...BIG, isRepo: false })
  await $.session.start(START)
  await $.turn.complete(TURN)
  await clock.advance(300_000)

  expect(calls).toHaveLength(1)
  expect(toasts).toEqual([])
  expect(statuses).toEqual([])
  expect((await $.command.run(RUN)).text).toBe(`Not a git repository: ${CWD}`)
})

test('a new repository counts lines as 0 and relies on files', async ($, on) => {
  const { toasts, statuses } = engine(on, { isRepo: true, status: files(8), shortstat: '', commitAgo: undefined })
  await $.session.start(START)

  expect(statuses.at(-1)).toBe('NoteOS: 8 files, +0 −0 uncommitted · no commit yet')
  expect(toasts.map(t => t.text)).toEqual(['NoteOS: 8 uncommitted files and no commit yet.'])
})

test('a git that fails leaves the line as it was and never throws', async ($, on) => {
  const world: World = { ...BIG }
  const { statuses } = engine(on, world)
  await $.session.start(START)
  const shown = statuses.length

  world.isDown = true
  expect(await $.turn.complete(TURN)).toEqual({ text: 'done' })
  expect(statuses).toHaveLength(shown)
})

test('/commit-nudge lists the changes, the totals and the last commit', async ($, on) => {
  engine(on, { ...BIG, status: `${files(17)}?? notes.md\0` })
  await $.session.start(START)

  const { text } = await $.command.run(RUN)
  const rows = (text ?? '').split('\n')
  expect(rows[0]).toBe('NoteOS: 18 changed files, +420 −38 lines in tracked files.')
  expect(rows.filter(row => row.startsWith('   M src/'))).toHaveLength(15)
  expect(rows).toContain('  and 3 more')
  expect(text).toMatch(/Last commit: 52 min ago \(\d{4}-\d\d-\d\d \d\d:\d\d\) "Add the thing"/)
})
