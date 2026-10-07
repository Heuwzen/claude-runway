import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import { commitAtSeconds, detailsOf, levelOf, parseLog, parseShortstat, parseStatus, projectOf, statusOf, stepOf, toastOf } from './format'
import type { Snapshot } from './format'

const topAtom = atom({ plugin: 'CommitNudge', key: 'top' } as const, null)
const notifiedAtom = atom({ plugin: 'CommitNudge', key: 'notified' } as const, 0)
const seenAtom = atom({ plugin: 'CommitNudge', key: 'seen' } as const, 0)

const COMMAND = 'commit-nudge'
const EVERY_MS = 120_000
const TIMEOUT_MS = 5000
const TOAST_MS = 10_000

// No optional locks: a status that refreshes the index would be a write. The C
// locale keeps `--shortstat` in English whatever the person's language.
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }

type Sample = { top: string; snap: Snapshot; now: number }

// One measurement runs at a time; one asked for meanwhile runs once after it,
// so a turn's edits are never missed behind a timer's run.
let isBusy = false
let isQueued = false

// Git's answer, or undefined when it could not be run or timed out.
async function git($: EngineInterface, folder: string, args: string[]): Promise<ProcessRunResult | undefined> {
  try {
    return await $.process.run(['git', '-C', folder, ...args], { timeoutMs: TIMEOUT_MS, env: GIT_ENV })
  } catch {
    return undefined
  }
}

// The repository's top folder, '' when the chat's folder is not in one, null
// when that could not be told yet (git missing or slow): asked again next time.
async function topOf($: EngineInterface) {
  const known = await read($, topAtom)

  if (known !== null) {
    return known
  }

  const found = await git($, await $.session.cwd(), ['rev-parse', '--show-toplevel'])

  if (found === undefined) {
    return null
  }

  const top = found.exitCode === 0 ? found.stdout.trim() : ''
  await update($, topAtom, () => top)

  return top
}

// What the repository holds now: undefined when git failed, 'none' outside a repository.
async function sample($: EngineInterface): Promise<Sample | 'none' | undefined> {
  const top = await topOf($)

  if (top === '') {
    return 'none'
  }

  if (top === null) {
    return undefined
  }

  const [status, diff, log] = await Promise.all([
    git($, top, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    git($, top, ['diff', '--shortstat', 'HEAD']),
    git($, top, ['log', '-1', '--format=%ct%x09%s']),
  ])

  if (status === undefined || diff === undefined || log === undefined || status.exitCode !== 0) {
    return undefined
  }

  const last = log.exitCode === 0 ? parseLog(log.stdout) : undefined

  // Without a commit there is no HEAD to diff against, and lines count as 0.
  if (last !== undefined && diff.exitCode !== 0) {
    return undefined
  }

  const { added, removed } = last === undefined ? { added: 0, removed: 0 } : parseShortstat(diff.stdout)

  return { top, snap: { changes: parseStatus(status.stdout), added, removed, last }, now: await $.clock.now() }
}

async function show($: EngineInterface, { top, snap, now }: Sample) {
  const level = levelOf(snap, now)
  const project = projectOf(top)
  const step = stepOf(
    { notified: await read($, notifiedAtom), seen: await read($, seenAtom) },
    level,
    snap.changes.length,
    commitAtSeconds(snap),
  )

  await update($, notifiedAtom, () => step.notified)
  await update($, seenAtom, () => step.seen)
  await $.ui.status(level > 0 ? statusOf(project, snap, now) : undefined)

  if (step.shouldToast) {
    await $.ui.toast(toastOf(project, snap, now), { timeoutMs: TOAST_MS })
  }
}

async function refresh($: EngineInterface) {
  if (isBusy) {
    isQueued = true

    return
  }

  isBusy = true

  try {
    do {
      isQueued = false
      const got = await sample($)

      if (got !== undefined && got !== 'none') {
        await show($, got)
      }
    } while (isQueued)
  } catch {
    // A failed measurement leaves the line as it was; the next one tries again.
  } finally {
    isBusy = false
  }
}

async function describe($: EngineInterface) {
  try {
    const got = await sample($)

    if (got === 'none') {
      return `Not a git repository: ${await $.session.cwd()}`
    }

    return got === undefined ? 'Could not read the repository. Is git installed?' : detailsOf(projectOf(got.top), got.snap, got.now)
  } catch {
    return 'Could not read the repository.'
  }
}

async function begin($: EngineInterface) {
  try {
    await $.command.register({ name: COMMAND, description: 'Show uncommitted work in this project and the last commit' })

    // Outside a repository there is nothing to measure for the whole session.
    if ((await topOf($)) !== '') {
      $.clock.every(EVERY_MS, () => void refresh($))
      await refresh($)
    }
  } catch {
    // The mod stays quiet; the next turn measures again.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await begin($)

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    // A subagent's turn is part of the main turn that spawned it.
    if (e.agentId === undefined) {
      await refresh($)
    }

    return done
  })

  on('command.run', { command: COMMAND }, async $ => ({ text: await describe($) }))
}
