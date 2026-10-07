# CommitNudge

A quiet reminder for Claude Code when uncommitted work piles up in the chat's project, so a crash or a bad command cannot cost you hours of work.

It only nudges. It never commits, stages, stashes or runs any git command that writes.

## What it shows

- A status line under the prompt, only while it is nudging:
  `NoteOS: 14 files, +420 −38 uncommitted · last commit 52 min ago`
- A 10-second toast when a project enters level 1, and again when it rises to level 2:
  `NoteOS: 14 uncommitted files (+420 lines) and no commit for 52 min.`
- `/commit-nudge`: up to 15 changed paths with their git status codes (and how many more), the totals, and the last commit's time and subject.

The toast is armed again when the tree becomes clean or a new commit lands.

## Levels

| Level | When |
|---|---|
| 1 | The tree is dirty, the last commit is 30 minutes old or more (or there is none), and 150 or more lines changed or 8 or more files. |
| 2 | The tree is dirty and the last commit is 90 minutes old or more, or 600 or more lines changed, or 25 or more files. |

Files count changed tracked files and untracked files. Lines are the added and removed lines of tracked files (`git diff --shortstat HEAD`); untracked files add no lines. In a repository with no commit yet, lines count as 0 and only files count, and a missing commit does not by itself raise level 2.

## Requirements

- Claude Code with mods (function hooks) enabled, in the terminal or the desktop Code tab.
- `git` on the PATH. A chat whose folder is not in a git repository is left alone.

## Install

```sh
git clone https://github.com/Heuwzen/claude-code-commit-nudge ~/.claude/skills/commit-nudge
```

## How it works

The repository is the chat's working folder (`git rev-parse --show-toplevel`). After each turn and every 2 minutes, the mod runs three read-only commands, each with a 5-second timeout:

- `git status --porcelain=v1 -z --untracked-files=normal`
- `git diff --shortstat HEAD`
- `git log -1 --format=%ct%x09%s`

They run with `GIT_OPTIONAL_LOCKS=0`, so git does not even refresh the index, and `LC_ALL=C`, so the figures read the same in any language. If git is missing, slow or fails, the mod leaves the line as it was and tries again later.

The thresholds, levels and texts live in `hooks/format.ts`, with tests in `hooks/*.test.ts*`. Run them with `claude plugin test <folder>`.

## License

MIT
