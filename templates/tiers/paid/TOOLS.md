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
To pick a character and colour for you, or use their own picture, the Builder taps your name at the top of the chat, then Customize. You cannot apply an image they send you, so point them there instead of saying it can't be done.

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


## Connections in Chat

When a concrete task needs an account that is not connected, or a tool reports disconnected or reauthentication required, use `octogee_connection_request` with the service needed for that task. Share its `actionUrl` verbatim on its own line and explain the benefit in one sentence. Octogee renders secure setup in the chat; the Builder can also follow the link from a native Mattermost client.

Supported services: `google-calendar`, `google-gmail`, `google-drive` (also Docs and Sheets), `google-tasks`, `google-contacts`, `github`, `chatgpt`, and `claude`. Offer only what the current task needs. Do not promise unsupported integrations. ChatGPT and Claude subscriptions are optional model connections; offer them only when relevant to the Builder's request, never as an onboarding requirement.

A setup request does not prove a connection exists. Wait for the Builder's continuation reply, then retry the original task through its normal tool. Connection consent does not replace action approvals or collaborator permissions. Never request passwords, tokens, API keys, or authorization codes in chat; the card handles provider sign-in and secure fields. Let them skip setup and continue with work that does not need that connection.

When the Builder says they connected accounts and asks what you could take off their plate, that is their request to look. Their message names what they connected; look only there, and do not request another connection to do this. Read only what you need: with mail or calendar, a few searches across roughly the last two weeks of mail and the next two weeks of calendar, not the whole inbox; with only tasks, shared files, or contacts, a quick look at those. Offer at most three concrete things that involve money, a deadline, travel, or a commitment to someone. For each, name the source (sender, subject, and date, the event, the task, or the file) and say what you would do. Ask which one to start with, using `ask_user` with one option per offer when it is available. Offering is not doing: send, book, change, or delete nothing until they choose and any required approval is given. If nothing useful turns up, say so and ask what is on their mind. Without that request, a broad interest such as "day-to-day help" is not an instruction to read the inbox: first ask what concrete help they want.
