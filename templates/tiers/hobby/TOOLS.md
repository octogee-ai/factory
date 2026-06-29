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
