<h1 align="center">Runway</h1>

<p align="center">
  Live meters for your Claude limits and context, right above the prompt.<br>
  Plus three small mods that keep an eye on your Mac, your commits and your tokens.
</p>

<p align="center">
  <img src="screenshot.png" width="860" alt="The Claude desktop app with Runway's three meters above the prompt: the 5-hour limit at 17%, the weekly limit at 15% and the context window at 55%. MacLoad shows CPU and memory in the footer.">
</p>

Claude's usage limits are easy to forget until you hit one. Runway keeps them in view: how much of your 5-hour and weekly limits you've used, whether you're using them faster than they reset, and how full the chat's context window is.

## What's inside

### [Runway](runway)

The meters in the screenshot. A tick on each limit marks how much of its window has passed: when the bar runs past the tick, you're spending faster than the limit resets. If you're on course to run out before the reset, Runway tells you when, and it gives you a heads-up at 80% and 95%.

All your open chats show the same numbers. When no chat has had a reply for an hour, Runway says "no recent reading" instead of showing numbers that may be out of date.

### [MacLoad](mac-load)

Your Mac's CPU and memory, in the footer. When something is hogging the Mac, MacLoad names it:

```
CPU ▲ 92% · Memory 56% · Xcode using 8 cores
```

If the Mac is truly overloaded, you get a notification. Type `/mac-load` for a breakdown by app.

### [CommitNudge](commit-nudge)

Stays out of sight until uncommitted work piles up in your project, then speaks up:

```
my-app: 14 files, +420 −38 uncommitted · last commit 52 min ago
```

It only reminds. It never commits, stages or stashes anything.

### [UsageBreakdown](usage-breakdown)

Type `/usage-breakdown` to see where your tokens went over the last 5 hours and 7 days: by model, by main chat versus agents, and by project.

## Install

```bash
git clone https://github.com/Heuwzen/claude-runway ~/.claude/runway
~/.claude/runway/install.sh
```

New chats pick them up. Each mod works on its own, so you can install just the ones you want:

```bash
~/.claude/runway/install.sh runway mac-load
```

<details>
<summary><b>Updating, removing, and chats that are already open</b></summary>
<br>

- **Update:** `git -C ~/.claude/runway pull`
- **Remove:** `~/.claude/runway/install.sh --remove mac-load`, or `--remove` on its own for all four.
- **Open chats** in the desktop app keep the version they started with. To have updates reach them, add `"CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"` to the `env` block of `~/.claude/settings.json`.
- **Coming from `claude-code-rate-limits`?** That mod is now Runway. Delete `~/.claude/skills/rate-limits` and install as above.

</details>

## Nothing leaves your Mac

No network requests, no accounts, no telemetry. This is everything the mods use:

| Mod | Uses |
|---|---|
| Runway | The rate limits Claude Code already receives with each reply |
| MacLoad | `iostat`, `ps`, `sysctl` and `top` to read the Mac, and `osascript` to post its notification |
| CommitNudge | Read-only `git status`, `git diff` and `git log` |
| UsageBreakdown | The token counts of your own chats |

## Requirements

- Claude Code 2.1.288 or later, in the desktop app's Code tab or in the terminal
- A Claude Pro or Max plan for Runway, since Claude Code only receives rate limits on one
- macOS for MacLoad, and git for CommitNudge

Mods are an early-access Claude Code feature, so an update could break one. If that happens, please [open an issue](https://github.com/Heuwzen/claude-runway/issues).

## License

[MIT](LICENSE)
