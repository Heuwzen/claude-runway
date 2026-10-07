# Runway

Your Claude limits and the chat's context window as live meters, right above the prompt.

![Runway's three meters above the prompt in the Claude desktop app: the 5-hour limit, the weekly limit and the context window](../screenshot.png)

## What it shows

- **Your 5-hour and weekly limits.** Each meter is blue, turns amber with a ▲ at 80% and red with a ◆ at 95%, and you get a pop-up as it crosses each of those.
- **Your pace.** A tick on each meter marks how much of the window has passed. When the bar runs past the tick, you're using the limit faster than it resets.
- **A warning before you run out.** If you're on course to hit a limit before it resets, the meter says when: "→ limit in ~3h 48m".
- **When each window resets**, counting down.
- **How full the chat's context window is**, once a reply has reported it.

In the terminal, the same meters are drawn in text:

```
5-hour ▲ 86%   → limit in ~22m · resets in 2h 46m     Weekly 75%                  resets in 6h 16m
━━━━━━━━━━━━━━━━━━━━━━┿━━━━━━━━━━━━━━━╸──────────      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸──────┼──
```

## The same numbers in every chat

Claude Code learns your limits from Claude's replies, and Runway reads them there. Each chat saves its newest reading, and every open chat picks up the newest one within seconds, so switching chats never shows you older numbers. A new chat shows your limits before its first reply.

Your limits also count what you use on claude.ai and in Claude's other apps, which Runway can't see. So once no chat has had a reply for an hour, it says "no recent reading" instead of showing numbers that might be wrong by now. A window that has reset in the meantime says when it reset.

## Fits any window

The meters always line up, whatever the text above them does. In the desktop app, each meter has one fact beside its number: when it resets, or when you'll hit the limit. In the terminal, Runway fits in more where there's room, such as how old the reading is, and drops it again as the window narrows.

## Install

Runway installs with the other mods in this repository. See the [main README](../README.md#install).

## Development

```bash
claude plugin validate .
claude plugin test .
```

Once Claude Code has loaded the mod, `.claude-plugin/types/` holds the API types, and `tsc -p .` type-checks it.

## License

[MIT](../LICENSE)
