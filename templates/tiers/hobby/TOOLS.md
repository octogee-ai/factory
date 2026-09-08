# TOOLS.md — Technical Reference

## Workspace Layout

Your workspace root is the current directory. Everything lives here:
- `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md` — core files
- `memory/` — daily notes
- `projects/` — all project files (site source, project docs, etc.)

**Rules:**
- Never use `../` — you cannot write outside your workspace
- Never use absolute paths (`~/.openclaw/...`) — use relative paths only
- Project files go in `projects/{project-name}/`

## Technical Notes

### Media/Images
Save to `~/.openclaw/media/` before sending. Workspace paths are blocked for media.

### Chat Identity

Use `octogee_chat_set_identity` to set your visible Coach name, vibe, and avatar.
Do this after the Builder has picked a name and vibe with you.

If you want an avatar, first write a safe image inside the workspace, usually
`.octogee/avatar.svg`. Use simple generic shapes or emoji-inspired icons. No
brand logos, trademarks, external images, scripts, fonts, or copied character art.

```json
{
  "name": "Scout",
  "vibe": "Calm, direct, and practical.",
  "avatar": ".octogee/avatar.svg"
}
```

The platform renders the avatar safely, stores it as a durable workspace file,
updates Mattermost, and updates the app.

## Omarchy Desktop Cheat Sheet

On a Builder with a connected computer, use `computer` for desktop input.
Take a screenshot first, act on the observed screen, and verify the result.
Use the latest returned `frameId` when supplying coordinates or a frame reference.

Send a complete shortcut in one call: `{"action":"key","text":"SUPER+SPACE"}`.
`text` is required for key calls. A standalone `SUPER`/`META` tap does not open
Omarchy's menu; separate modifier and Space calls do not form a chord.

| Task | `computer` key `text` |
| --- | --- |
| Open/toggle the Omarchy menu (launcher) | `SUPER+SPACE` |
| Open the Apps menu directly | `SUPER+ALT+SPACE` |
| Dismiss a menu | `ESC` |
| Open a terminal | `SUPER+RETURN` |
| Open a browser | `SUPER+SHIFT+B` |
| Open the file manager | `SUPER+SHIFT+F` |
| Focus the adjacent window | `SUPER+LEFT`, `SUPER+RIGHT`, `SUPER+UP`, `SUPER+DOWN` |
| Toggle fullscreen | `SUPER+F` |
| Close the focused window | `SUPER+W` |

To enter literal text, focus the field and use `{"action":"type","text":"your text"}`.
Use `key` for shortcuts and `type` for text. Closing a menu with `ESC` preserves
its underlying application; closing a window may discard work.

These are Omarchy defaults; the Builder may customize them. If a shortcut
succeeds but nothing changes, inspect the screenshot and current bindings before
retrying. When terminal access is available on the desktop host,
`omarchy menu keybindings --print` lists bindings. Gateway filesystem tools may
run in a different container from the desktop. Report actual tool errors;
an unchanged screen alone does not establish that the input channel disconnected.
