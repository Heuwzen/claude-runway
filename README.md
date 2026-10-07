# UsageBreakdown

A Claude Code mod that shows what is using up your Claude limits: tokens by model, by main chat versus agents, and by project, across every chat on this Mac.

Run `/usage-breakdown` to open a pane with two sections, "Last 5 hours" and "Last 7 days". Each is grouped three ways, by model, by source (main chats or agents) and by project (the top 6, then "Other"). Every row has a bar, its share and a compact token count.

Shares are of tokens (input + cache write + output), not of your limits: Opus uses more of your limits per token than Sonnet. Cache reads are left out.

## Requirements

A Claude Code build with function-hook mods (the desktop app's Code tab or the terminal). No other tools or accounts.

## Install

```
git clone https://github.com/Heuwzen/claude-code-usage-breakdown ~/.claude/skills/usage-breakdown
```

## How it works

- Every model request, the main chat's or a subagent's, passes through a `turn.step` hook. The hook forwards the response untouched and, once it is whole, adds its token counts to the current hour.
- Counts are kept per chat under `session:<id>` in the mod's store, in one-hour buckets by model and source. A chat writes at most every 30 seconds, and only when something changed. Hours older than 8 days are dropped, and so are chats not updated for 8 days. The mod trims the oldest chats if the store ever passes 2 MiB.
- A chat's project is the folder name of its git repository (the main working tree, for a worktree), or of its working folder outside one.
- The pane adds up every chat's saved counts, taking this chat's live. It refreshes when opened and every 60 seconds while open.
- Counting starts when the mod is installed; earlier chats are not counted. A window includes every hour that overlaps it, so "Last 5 hours" covers a little over 5 hours.
