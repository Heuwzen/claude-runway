# Runway

The mod this collection is named after. It keeps your 5-hour and weekly usage limits, and how full the chat's context window is, on screen as slim meters right above the prompt, so you can see how much runway you have left.

![Runway's meters above the prompt in the Claude desktop app](../screenshot.png)

In the terminal:

```
5-hour ▲ 86%   → limit in ~22m · resets in 2h 46m     Weekly 75%                  resets in 6h 16m
━━━━━━━━━━━━━━━━━━━━━━┿━━━━━━━━━━━━━━━╸──────────      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸──────┼──
```

## What it shows

- **Each limit window** as a meter: blue normally, amber with ▲ from 80%, red with ◆ from 95%.
- **A tick on each meter** marking how far through the window you are. Fill past the tick means you are using the limit faster than it resets.
- **A forecast** when you are on course to run out before the reset, such as "→ limit in ~22m".
- **Reset countdowns**, and a toast when a window crosses 80% and again at 95%.
- **How full this chat's context window is**, as a third meter, once a reply has reported it.
- **Level meters at any width.** The meters always sit on one row, whatever the text above them does. In the desktop app each meter has one fact beside its number: when its window resets, or when you're on course to hit the limit. The terminal fits more where there's room, dropping the reading's age first, then the reset time, as the window narrows.
- **The same numbers in every chat.** Each chat saves its newest reading, and every open chat picks up the newest one any chat has within seconds. A new chat shows it before its own first reply. The terminal also shows the reading's age ("as of 12m ago") where there's room.
- **No stale numbers.** Claude Code only learns your limits from a reply, and limits count your use everywhere. So when no chat has had a reply for an hour, the band says "no recent reading" instead of numbers that may be wrong by now. A window that has reset since then shows when it reset.

It reads the rate-limit information Claude Code already receives with each reply. It makes no requests of its own, and nothing leaves your machine.

## Requirements

- Claude Code 2.1.288 or later. Mods are an early-access feature, so a Claude Code update may break this mod; please open an issue if it does.
- A Claude subscription (Pro or Max). Claude Code only receives rate-limit information on a subscription.
- The meters show in the Claude desktop app's Code tab and in the terminal.

## Install

Install it with the other mods in this repository: see the [main README](../README.md#install).

## Development

```bash
claude plugin validate .
claude plugin test .
```

Once Claude Code has loaded the mod, `.claude-plugin/types/` holds the API types, and `tsc -p .` type-checks it.

## License

MIT, see [LICENSE](../LICENSE).
