# CommitNudge

A quiet reminder to commit. CommitNudge stays out of sight until uncommitted work piles up in your project, then speaks up, so a crash or a bad command can't cost you hours of work.

```
my-app: 14 files, +420 −38 uncommitted · last commit 52 min ago
```

It only reminds. It never commits, stages, stashes or runs any git command that writes.

## What it shows

- **A line in the footer**, like the one above, only while there's work to commit.
- **A pop-up** when it first nudges, and again if it nudges harder: "my-app: 14 uncommitted files (+420 lines) and no commit for 52 min."
- **`/commit-nudge`:** the changed files with their git status, the totals, and your last commit's time and message.

Once you commit, or the working tree is clean again, the nudges start over.

## When it nudges

- **A nudge:** at least 8 changed files or 150 changed lines, and no commit for 30 minutes.
- **A harder nudge:** 25 changed files or 600 changed lines, or no commit for 90 minutes while anything is uncommitted.

Files include new, untracked ones. Lines are the lines added and removed in tracked files.

## How it works

CommitNudge reads the git repository of the chat's folder after each of Claude's replies and every 2 minutes, with three read-only commands:

- `git status` for the changed files
- `git diff --shortstat HEAD` for the changed lines
- `git log -1` for your last commit

They run with `GIT_OPTIONAL_LOCKS=0`, so git doesn't even refresh its index, and with a 5-second timeout. A chat outside a git repository is left alone.

## Requirements

Claude Code and git.

## Install

CommitNudge installs with the other mods in this repository. See the [main README](../README.md#install).

## Development

```bash
claude plugin validate .
claude plugin test .
```

The thresholds, levels and text live in `hooks/format.ts`.

## License

[MIT](../LICENSE)
