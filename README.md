# Runway

Four small mods for Claude Code that keep you aware while you work: how much of your usage limits and context you have left, how hard your Mac is working, how much work is still uncommitted, and where your tokens go.

![Runway's meters above the prompt in the Claude desktop app](screenshot.png)

| Mod | What it does |
|---|---|
| [Runway](runway) | Your 5-hour and weekly limits and the chat's context window as meters above the prompt, with a warning when you're on course to hit a limit before it resets. |
| [MacLoad](mac-load) | Your Mac's CPU and memory under the prompt. It names the app behind a slowdown, and sends a notification when the Mac is overloaded. |
| [CommitNudge](commit-nudge) | A quiet nudge when uncommitted work piles up in the project you're working on. It never commits anything itself. |
| [UsageBreakdown](usage-breakdown) | `/usage-breakdown` shows which models, chats, agents and projects your tokens went to over the last 5 hours and 7 days. |

Each is a mod of its own: install any of them, and each shows under its own name.

## Install

```bash
git clone https://github.com/Heuwzen/claude-runway ~/.claude/runway
~/.claude/runway/install.sh
```

This links the mods into `~/.claude/skills`, where Claude Code loads them in every new chat. To install only some, name them:

```bash
~/.claude/runway/install.sh runway mac-load
```

- **Update** with `git -C ~/.claude/runway pull`.
- **Remove** one with `~/.claude/runway/install.sh --remove mac-load`, or all of them with `~/.claude/runway/install.sh --remove`.
- **Open chats** in the desktop app keep the version they opened with. To have updates reach them too, add this to the `env` block of `~/.claude/settings.json`:

  ```json
  "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
  ```

If you installed the earlier `claude-code-rate-limits`, delete `~/.claude/skills/rate-limits` and install as above. That mod is now Runway.

## Requirements

- Claude Code 2.1.288 or later, in the desktop app's Code tab or the terminal. Mods are an early-access feature, so a Claude Code update may break one; please open an issue if it does.
- Runway needs a Claude subscription (Pro or Max): Claude Code only receives rate-limit information on one.
- MacLoad needs macOS. CommitNudge needs git.

Nothing here makes network requests or sends anything off your machine. Each mod's README says exactly what it reads and runs.

## License

MIT, see [LICENSE](LICENSE).
