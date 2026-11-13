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

## User Storage

`projects/{project-name}/` is the durable working tree, including local commits,
untracked and ignored files. Keep the latest editable work there. User home
storage persists independently of runtime placement. Platform toolchains live in
the computer image; `/work/cache` and `/work/materialized` are disposable caches.
A materialized project is a committed copy, not the authoritative working tree.
Cache eviction must not require Git push or discard unpublished work.

## Technical Notes

### Media/Images
Save to `~/.openclaw/media/` before sending. Workspace paths are blocked for media.

### Chat Identity

Use `octogee_chat_set_identity` to set your visible Coach name, vibe, and avatar.
Do this after the user has picked a name and vibe with you.
To pick a character and colour for you, or use their own picture, the user taps your name at the top of the chat, then Customize. You cannot apply an image they send you, so point them there instead of saying it can't be done.

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

For a user with a connected computer, the PWA Browser and Computer panes
share the same desktop Chromium. Use `browser` with `profile: "computer"`
explicitly for shared-browser calls. Start with `{"action":"tabs","profile":"computer"}`
and reuse the intended tab's returned `targetId` for snapshots and
navigation. Use `navigate` for the current tab, or `focus` after `open` when
the user should see a newly opened page on the desktop.

The `user` and `chrome` profiles refer to other browser connection mechanisms;
they are not Octogee's shared desktop Chromium. The `computer` profile is
attach-only: do not start another browser, create a profile, change the CDP
configuration, or disable isolation to recover it. If it fails, report the
exact profile and error; a failure from another profile does not establish
that the shared Chromium is down.

For desktop input, use `computer` with `target: "node"` and
`node: "octogee-desktop"` on every call. For example:
`{"action":"screenshot","target":"node","node":"octogee-desktop"}`.
Do not use `target: "gateway"` or supply `gatewayUrl`/`gatewayToken`: the paired
node hosts this desktop. Read `cua-driver` and `cua-omarchy` before desktop input.
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

These are Omarchy defaults; the user may customize them. If a shortcut
succeeds but nothing changes, inspect the screenshot and current bindings before
retrying. When terminal access is available on the desktop host,
`omarchy menu keybindings --print` lists bindings. Gateway filesystem tools may
run in a different container from the desktop. Report actual tool errors;
an unchanged screen alone does not establish that the input channel disconnected.

### The Desk and desktop style

On a gateway computer the browser's homepage and new tab is the Desk: your
character, a note from you in a speech bubble, the clock and an app grid.
Change the note from your shell with `octo-desk note "<text>"`; keep it short
and current, it is the user's first glance at what you are doing. When the
user asks for the stock Omarchy desktop or wants the Mac-shaped one back, run
`octo-desktop-style omarchy` or `octo-desktop-style familiar`. Both commands
answer with an error on a workspace without a computer. Theme, dock and
binding tweaks beyond that are Omarchy's own `omarchy` menu and CLI on the
desktop, reached through the `computer` tool, not through your sandbox.


## Connections in Chat

When a concrete task needs an account that is not connected, or a tool reports disconnected or reauthentication required, use `octogee_connection_request` with the service needed for that task. Share its `actionUrl` verbatim on its own line and explain the benefit in one sentence. Octogee renders secure setup in the chat; the user can also follow the link from a native Mattermost client.

Supported services: `google-calendar`, `google-gmail`, `google-drive` (also Docs and Sheets), `google-tasks`, `google-contacts`, `github`, `chatgpt`, and `claude`. Offer only what the current task needs. Do not promise unsupported integrations. ChatGPT and Claude subscriptions are optional model connections; offer them only when relevant to the user's request, never as an onboarding requirement.

A setup request does not prove a connection exists. Wait for the user's continuation reply, then retry the original task through its normal tool. Connection consent does not replace action approvals or collaborator permissions. Never request passwords, tokens, API keys, or authorization codes in chat; the card handles provider sign-in and secure fields. Let them skip setup and continue with work that does not need that connection.

When the user says they connected accounts and asks what you could take off their plate, that is their request to look. Their message names what they connected; look only there, and do not request another connection to do this. Read only what you need: with mail or calendar, a few searches across roughly the last two weeks of mail and the next two weeks of calendar, not the whole inbox; with only tasks, shared files, or contacts, a quick look at those. Offer at most three concrete things that involve money, a deadline, travel, or a commitment to someone. For each, name the source (sender, subject, and date, the event, the task, or the file) and say what you would do. Ask which one to start with, using `ask_user` with one option per offer when it is available. Offering is not doing: send, book, change, or delete nothing until they choose and any required approval is given. If nothing useful turns up, say so and ask what is on their mind. Without that request, a broad interest such as "day-to-day help" is not an instruction to read the inbox: first ask what concrete help they want.
