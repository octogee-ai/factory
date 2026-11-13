# TOOLS.md — Technical Reference

## Workspace Layout

Your workspace root is the current directory:

- `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`: your core files
- `memory/`: daily notes
- `projects/<slug>/`: one checkout per project

Rules:

- Use relative paths. Never use `../` or absolute paths such as `~/.openclaw/...`;
  you cannot write outside the workspace.
- A project's files go in `projects/<slug>/`.

## Storage

`projects/<slug>/` is the durable working tree, including local commits and
untracked files. Keep the latest editable work there. The platform saves the
workspace and each project to Gitea, and keeps large binary files outside Git.
`/work/cache` and `/work/materialized` are disposable caches; a materialized
project is a committed copy, not the working tree.

## Git on an Isolated Gateway

Each checkout is already wired to its Gitea repository, and the platform's
saves push it there.

- Commit small, coherent changes with a message that says what and why.
- Don't add remotes or credentials. If a push you run is refused, report the
  error.
- Never rewrite history that has been pushed.

## Mattermost

Use the `message` tool with `channel=mattermost`:

- `action=react` with the post's `messageId` to acknowledge a post.
- `action=read` with a channel target to read recent posts.
- Search, pins and member lookups are available too.

A bare Mattermost ID can name a user or a channel. Always send to
`channel:<id>` or `user:<id>`.

## Media

Save a file under `~/.openclaw/media/` before you send it. Workspace paths are
blocked for media.

## Desktop

On an isolated gateway with a desktop, the browser and the desktop are shared
with the user.

- Use `browser` with `profile: "computer"` on every shared-browser call. Start
  with `{"action":"tabs","profile":"computer"}` and reuse the returned
  `targetId`. The profile is attach-only: never start another browser, create a
  profile or change its configuration to recover it. If it fails, report the
  profile and the error.
- Use `computer` with `target: "node"` and `node: "octogee-desktop"` on every
  call, for example `{"action":"screenshot","target":"node","node":"octogee-desktop"}`.
  Don't use `target: "gateway"` or pass `gatewayUrl` or `gatewayToken`. Read the
  `cua-driver` and `cua-omarchy` skills before desktop input. Take a screenshot
  first, act on what you see, verify the result, and use the latest `frameId`
  for coordinates.
- Send a whole shortcut in one call, such as `{"action":"key","text":"SUPER+SPACE"}`.
  Use `key` for shortcuts and `type` for text.

| Task | `computer` key `text` |
| --- | --- |
| Open or close the launcher | `SUPER+SPACE` |
| Open the Apps menu | `SUPER+ALT+SPACE` |
| Dismiss a menu | `ESC` |
| Open a terminal | `SUPER+RETURN` |
| Open a browser | `SUPER+SHIFT+B` |
| Open the file manager | `SUPER+SHIFT+F` |
| Focus the adjacent window | `SUPER+LEFT`, `SUPER+RIGHT`, `SUPER+UP`, `SUPER+DOWN` |
| Toggle fullscreen | `SUPER+F` |
| Close the focused window | `SUPER+W` |

These are Omarchy defaults and the user may change them. When a shortcut has no
visible effect, check the screenshot and the current bindings
(`omarchy menu keybindings --print` in a desktop terminal) before retrying.
Gateway file tools may run in a different container from the desktop.
