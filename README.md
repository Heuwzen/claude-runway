# mac-load

A mod for Claude Code that keeps your Mac's CPU and memory on screen under the prompt. When the Mac slows down, it names the app behind it, and it warns you when the Mac is truly overloaded. Built for one Mac shared by several Claude chats, Xcode builds and iOS simulators.

```
CPU 28% · Memory 56% · 1 sim
CPU ▲ 92% · Memory 56% · Xcode using 8 cores
CPU ◆ 100% · Memory 56% · Simulator using 3 cores
```

- **CPU** is how busy all the cores are, as Activity Monitor's CPU graph shows it.
- **Memory** is the share of memory macOS can't hand to apps right away, and its mark follows the memory pressure Activity Monitor shows.
- **Sims** counts the booted iOS simulators. It's left out when none are booted.
- A `▲` marks whatever is strained, and a `◆` whatever is overloaded. The app using the most CPU, or the most memory when memory is the problem, is named after them.
- A toast appears only when the Mac is overloaded, such as: "Mac is overloaded: CPU at 100%, Simulator using 3 cores. Shut down simulators you are not using." Each chat shows it at most once every 10 minutes.
- `/mac-load` breaks the Mac down by app: the busiest apps and the largest, each booted simulator by name, the load over 1, 5 and 15 minutes, and swap use.

## Levels

| | Busy ▲ | Overloaded ◆ |
|---|---|---|
| CPU | 85% or more, until it falls under 70% | 90% or more while the load is 3 times the cores or more, until the CPU falls under 75% or the load under 2 times the cores |
| Memory | macOS reports memory pressure as "warning" (yellow in Activity Monitor) | macOS reports it as "critical" (red) |
| Simulators | 3 or more booted | |

On its own, a build that keeps every core busy counts as busy, not overloaded. Overloaded means work is queueing for the cores, as it does with several builds at once or a runaway simulator. The load average alone isn't used for this, because on a Mac it lags behind and can stay high over idle cores.

## Requirements

- macOS, with Claude Code (the terminal or the desktop app's Code tab) running with mods enabled.
- Nothing else. The simulator count comes from the process list, so Macs without Xcode work too. Simulator names in `/mac-load` use `xcrun simctl`, which only runs when a simulator is booted.

## Install

```
git clone https://github.com/Heuwzen/claude-code-mac-load ~/.claude/skills/mac-load
```

## How it works

At session start and every 30 seconds, the mod runs three read-only commands. Each runs by its full path, with no shell, in the C locale, and with a 10 second timeout:

- `/usr/sbin/iostat -n0 -c 2 -w 2` for the CPU over two seconds
- `/bin/ps -A -o pid=,pcpu=,comm=` for each process's CPU and app, and the booted simulators
- `/usr/sbin/sysctl` for the cores, memory, memory pressure, load and swap

While memory is strained, it also runs `/usr/bin/top -l 1 -o mem -n 100 -stats pid,mem`. That reads each process's memory footprint, the figure Activity Monitor shows, so it can name the largest app. `/mac-load` always reads it.

Processes are grouped into apps by where their programs live:

- anything of the iOS simulators counts as Simulator
- Xcode's tools and toolchains, including every build process, count as Xcode
- other processes count under the outermost `.app` bundle they're in, so all of Claude's helper processes count as Claude
- macOS's own processes count as macOS

If three readings in a row fail on a system the mod has never read, such as one that isn't a Mac, it clears its line and stops. Once a reading has worked on a Mac, a failed one counts as a Mac too busy to answer in time, which is when a reading matters most. The mod then keeps trying and shows the last reading with its age.

## Development

```
claude plugin validate .
claude plugin test .
```

The parsing, grouping, levels and text are in `hooks/format.ts`, with no engine calls, so they can be tested alone. `hooks/register.tsx` holds the polling, the toasts and the command.
