# star-pins

A star in the Claude desktop app's prompt footer. Click it to pin the chat you're in to the top of the sidebar, and click it again to unpin.

```
☆   not pinned
★   pinned
```

## What it shows

- **The chat's pin:** an outline star while the chat isn't pinned, a filled one while it is. Pin or unpin from the sidebar instead and the star follows within 10 seconds.
- **One click:** the star changes the moment you click it. If the app refuses the change, the star turns back and a note says why.
- **Where it sits:** in the footer under the prompt box, after other mods' readouts such as MacLoad's and before the model name. The desktop app keeps the left side of the footer for itself.
- **Desktop only:** pins live in the desktop app's sidebar, so in a terminal star-pins draws nothing.

## How it works

star-pins uses the desktop app's own sidebar tools, the ones Claude uses when you ask it to pin a chat. It reads the chat's pin with `get_session`, again after each reply and every 10 seconds while the chat sits idle, and changes it with `set_pinned`.

The change runs as a tool call, so your permission settings apply to it as they do to Claude's own tool calls. In auto mode the change is refused until you allow the tool, in the `permissions` block of `~/.claude/settings.json`:

```json
"allow": ["mcp__ccd_sidebar__set_pinned"]
```

That rule also lets Claude pin and unpin chats without asking. It only changes the sidebar.
