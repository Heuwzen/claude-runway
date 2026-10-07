# UsageBreakdown

See where your tokens go. Type `/usage-breakdown` and a pane opens with your last 5 hours and your last 7 days, across every chat on this Mac, broken down three ways:

- **By model**, such as Opus 5.5 and Sonnet 5.5
- **By source:** your main chats, or the agents they start
- **By project:** your six busiest, then everything else

For example:

```
Last 5 hours  3.1M tokens · 214 requests

By model
Opus 5.5   ████████████████████████████████▊         82%  2.5M
Sonnet 5.5 ███████▎                                  18%  560k

By source
Main chats █████████████████████████▋                64%    2M
Agents     ██████████████▍                           36%  1.1M

By project
api-server ██████████████████▊                       47%  1.5M
ios-app    ████████████▍                             31%  960k
website    █████▋                                    14%  430k
Other      ███▎                                       8%  250k
```

The shares are of tokens (input, cache writes and output), not of your limits: Opus uses more of your limits per token than Sonnet. Cache reads are left out.

## How it works

- Every model request, from a chat or from an agent, passes through UsageBreakdown on its way back. It reads the token counts and passes the response on untouched.
- Counts are kept per chat in hourly buckets and saved at most every 30 seconds. Anything older than 8 days is dropped.
- A chat's project is its git repository's folder name, or its working folder outside a repository.
- The pane adds up every chat's counts and refreshes every minute while it's open.
- Counting starts when you install it. "Last 5 hours" counts every hour that overlaps those 5 hours, so it can reach a little further back.

## Requirements

Claude Code. Nothing else.

## Install

UsageBreakdown installs with the other mods in this repository. See the [main README](../README.md#install).

## Development

```bash
claude plugin validate .
claude plugin test .
```

## License

[MIT](../LICENSE)
