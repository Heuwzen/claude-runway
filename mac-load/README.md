# MacLoad

Your Mac's CPU and memory, in Claude Code's footer. When the Mac slows down, MacLoad names the app behind it, and it tells you when the Mac is truly overloaded. Made for one Mac shared by several Claude chats, Xcode builds and iOS simulators.

```
CPU 28% · Memory 56% · 1 sim
CPU ▲ 92% · Memory 56% · Xcode using 8 cores
CPU ◆ 100% · Memory 51% · Simulator using 6 cores
```

## What it shows

- **CPU:** how busy all the cores are, as in Activity Monitor's CPU graph.
- **Memory:** the share of memory macOS can't hand to apps right away. Its mark follows the memory pressure Activity Monitor shows.
- **Sims:** how many simulators are booted, including the ones Xcode boots for previews. Left out when there are none, or when the line names an app instead.
- **The culprit:** a ▲ marks what's strained and a ◆ what's overloaded. The line then names the app using the most CPU, or the most memory when memory is the problem.
- **A notification** at the top right of your screen when the Mac is overloaded: "Mac is overloaded: CPU at 100%, Simulator using 6 cores. Shut down simulators you are not using." You get one per overload, not one per chat, and at most one every 10 minutes.
- **`/mac-load`:** a breakdown by app, with each booted simulator by name, the load over 1, 5 and 15 minutes, and swap. It answers straight away, even while Claude is replying.

## Levels

| | Busy ▲ | Overloaded ◆ |
|---|---|---|
| CPU | 85% or more, until it drops under 70% | 90% or more with a load of 3× the cores, until the CPU drops under 75% or the load under 2× the cores |
| Memory | Memory pressure "warning", yellow in Activity Monitor | Memory pressure "critical", red in Activity Monitor |
| Simulators | 3 or more booted | |

A single build that keeps every core busy counts as busy. Overloaded means work is queueing for the cores, as with several builds at once or a runaway simulator. MacLoad doesn't go by the load average alone, because on a Mac it lags and can stay high over idle cores.

## How it works

Every 30 seconds, one open chat reads the Mac and the others show its reading, so ten open chats cost about as much as one. A reading runs three read-only commands, each by its full path, with no shell and a 10-second timeout:

- `iostat` for the CPU over two seconds
- `ps` for each process's CPU and the app it belongs to
- `sysctl` for the cores, memory, memory pressure, load and swap

While memory is strained, it also runs `top` to read each process's memory footprint, the figure Activity Monitor shows. The notification is posted with `osascript`; the first time, macOS may ask you to allow notifications from Script Editor, which posts them for `osascript`.

Processes are grouped into apps by where their programs live:

- **Simulator:** everything the simulators run.
- **Xcode:** Xcode itself and the processes of a build. Tools that merely ship with Xcode, like git and python3, count under their own names.
- **Web pages:** WebKit's processes, which draw pages for Safari and for any app with a web view.
- **Virtual machine:** a VM's guest, as Docker, OrbStack or UTM run it.
- **Everything else** counts under the `.app` it lives in, so all of Claude's helper processes count as Claude. macOS's own processes count as macOS, and other programs under their own names.

On a system MacLoad has never read, such as one that isn't a Mac, it gives up after three tries. Once it has worked, a failed reading means the Mac was too busy to answer in time, so it keeps trying and shows the last reading with its age.

## Requirements

macOS and Claude Code. Nothing else: Macs without Xcode work too.

## Install

MacLoad installs with the other mods in this repository. See the [main README](../README.md#install).

## Development

```bash
claude plugin validate .
claude plugin test .
```

The parsing, grouping, levels and text live in `hooks/format.ts`, with no calls into Claude Code, so they can be tested alone. `hooks/register.tsx` holds the polling, the shared reading, the alerts and the command.

## License

[MIT](../LICENSE)
