# mac-load

A mod for Claude Code that keeps your Mac's load on screen under the prompt, and warns you before it bogs down. Built for one Mac shared by several Claude chats, Xcode builds and iOS simulators.

```
▲ Mac load 18.0 / 10 cores · 23% memory free · 3 simulators
```

- The status line is always on. A `▲` marks a busy Mac and a `◆` an overloaded one. The simulators part is left out when none are booted.
- A 10 second toast appears when the Mac turns busy, turns overloaded, or goes from busy to overloaded.
- `/mac-load` shows the details: load over 1, 5 and 15 minutes against the cores, free memory, and each booted simulator by name, with the command to shut them all down.

## Levels

| Level | When |
|---|---|
| busy | load (1 min) is 1.5 times the cores or more, or under 15% memory is free, or 3 or more simulators are booted |
| overloaded | load (1 min) is 3 times the cores or more, or under 8% memory is free |

A level is left only when the Mac is well clear of it: load under 0.8 times that level's threshold, memory at least 5 points above its limit, and (for busy) fewer than 3 simulators. This keeps the warning from flapping around a threshold.

## Requirements

- macOS, with Claude Code (the terminal or the desktop app's Code tab) running with mods enabled.
- Xcode's command line tools for the simulator count. Without `xcrun`, the mod shows no simulators and says nothing about them.

## Install

```
git clone https://github.com/Heuwzen/claude-code-mac-load ~/.claude/skills/mac-load
```

## How it works

At session start and every 30 seconds, the mod runs four read-only commands, each with a timeout of at most 5 seconds and no shell:

- `sysctl -n vm.loadavg` for the load
- `sysctl -n hw.logicalcpu` for the cores
- `memory_pressure -Q` for free memory
- `xcrun simctl list devices booted --json` for the booted simulators

It keeps the latest reading and the current level in the session state. Each chat polls on its own, so each chat shows its own toasts.

If `sysctl` fails on the first reading (not a Mac), the mod clears its status line and stops polling. Later, it tolerates a lone failed reading and stops after three in a row. If only `memory_pressure` fails, memory is left out of the line and the levels.

## Development

```
claude plugin validate .
claude plugin test .
```

The parsing, thresholds and text are in `hooks/format.ts`, with no engine calls, so they can be tested alone. `hooks/register.tsx` holds the polling and the command.
