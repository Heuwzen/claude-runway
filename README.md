# mac-load

A mod for Claude Code that keeps your Mac's CPU and memory on screen under the prompt. When the Mac slows down, it names the app behind it, and it warns you when the Mac is truly overloaded. Built for one Mac shared by several Claude chats, Xcode builds and iOS simulators.

```
CPU 28% · Memory 56% · 1 sim
CPU ▲ 92% · Memory 56% · Xcode using 8 cores
CPU ◆ 100% · Memory 51% · Simulator using 6 cores
```

- **CPU** is how busy all the cores are, as Activity Monitor's CPU graph shows it.
- **Memory** is the share of memory macOS can't hand to apps right away, and its mark follows the memory pressure Activity Monitor shows.
- **Sims** counts the booted simulators: iOS, watchOS, tvOS and visionOS, plus those Xcode boots for its previews. It's left out when none are booted, and when the line names an app instead, unless the simulators are the problem.
- A `▲` marks whatever is strained, and a `◆` whatever is overloaded. The line then names the app using the most CPU, or the most memory when memory is the problem. An app is named for the CPU only when it holds at least a quarter of the busy cores.
- A toast appears only when the Mac is overloaded, such as: "Mac is overloaded: CPU at 100%, Simulator using 6 cores. Shut down simulators you are not using." Each chat shows it at most once every 10 minutes.
- `/mac-load` breaks the Mac down by app: the busiest apps and the largest, each booted simulator by name, the load over 1, 5 and 15 minutes, and swap use. It answers at once, even while a reply is still running.

## Levels

| | Busy ▲ | Overloaded ◆ |
|---|---|---|
| CPU | 85% or more, until it falls under 70% | 90% or more while the load is 3 times the cores or more, until the CPU falls under 75% or the load under 2 times the cores |
| Memory | macOS reports memory pressure as "warning" (yellow in Activity Monitor) | macOS reports it as "critical" (red) |
| Simulators | 3 or more booted | |

On a Mac that doesn't report memory pressure, memory is busy from 85% in use and overloaded from 92%.

On its own, a build that keeps every core busy counts as busy, not overloaded. Overloaded means work is queueing for the cores, as it does with several builds at once or a runaway simulator. The load average alone isn't used for this, because on a Mac it lags behind and can stay high over idle cores.

## Requirements

- macOS, with Claude Code (the terminal or the desktop app's Code tab) running with mods enabled.
- Nothing else. The simulator count comes from the process list, so Macs without Xcode work too. Simulator names in `/mac-load` use `xcrun simctl`, which only runs when a simulator is booted.

## Install

```
git clone https://github.com/Heuwzen/claude-code-mac-load ~/.claude/skills/mac-load
```

## How it works

Every 30 seconds, one open chat reads the Mac and saves the reading. The other chats show that reading instead of reading the Mac themselves. A chat only reads the Mac when no reading is under 25 seconds old, so ten open chats cost about as much as one.

A reading runs three read-only commands. Each runs by its full path, with no shell, from `/`, and with a 10 second timeout:

- `/usr/sbin/iostat -n0 -c 2 -w 2` for the CPU over two seconds
- `/bin/ps -A -o pid=,ppid=,pcpu=,comm=` for each process's CPU and app, and the booted simulators
- `/usr/sbin/sysctl` for the cores, memory, memory pressure, load and swap

iostat and sysctl run in the C locale, so their numbers come with decimal points. ps runs in UTF-8, so app names such as "Café" come through whole. If iostat doesn't answer in time, the CPU is added up from the processes instead.

While memory is strained, a reading also runs `/usr/bin/top -l 1 -o mem -stats pid,mem`. That reads every process's memory footprint, the figure Activity Monitor shows, so the largest app can be named. `/mac-load` always reads it.

Processes are grouped into apps by where their programs live:

- **Simulator:** anything of the simulators, including the unnamed processes a simulator starts.
- **Xcode:** Xcode itself and the processes of a build: compilers, the linker, the build service and the like. Other programs that ship inside the developer tools, such as git, make and python3, count under their own names.
- **Web pages:** WebKit's processes, which draw web pages for Safari and for any app with a web view.
- **Virtual machine:** a virtual machine's guest, as Docker, OrbStack or UTM run it.
- **Each app:** everything else inside an app counts under the outermost `.app` bundle it's in, so all of Claude's helper processes count as Claude.
- **macOS:** macOS's own processes. Homebrew's programs, even under `/usr/local`, count under their own names.

If three readings in a row fail on a system the mod has never read, such as one that isn't a Mac, it clears its line and stops. Once a reading has worked on a Mac, a failed one counts as a Mac too busy to answer in time, which is when a reading matters most. The mod then keeps trying and shows the last reading with its age.

## Development

```
claude plugin validate .
claude plugin test .
```

The parsing, grouping, levels and text are in `hooks/format.ts`, with no engine calls, so they can be tested alone. `hooks/register.tsx` holds the polling, the shared reading, the toasts and the command.
