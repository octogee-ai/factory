/**
 * Octogee identity — the canonical module.
 *
 * Single source of truth for every rule about usernames, channel names,
 * and project identifiers. Every package (app, workspace-api, chat-proxy,
 * functions, scripts, site, tests) imports from here directly. No mirrors,
 * no re-export shims, no drift-pin tests.
 *
 * Spec: `docs/DATA-MODEL-REVIEW.md` §11 (v3.1 finalization — username IS
 * the workspace slug, the MM team name, the Gitea team name, the coach
 * id, the URL path segment; derived channel names use it as a prefix).
 *
 * Compatibility: `USERNAME_RE` is a strict subset of Mattermost's team-name
 * regex (`server/public/model/team.go`). The length budget below fits
 * inside MM's 64-char channel-name cap by construction.
 */

// ── Length + regex constants ─────────────────────────────────────────────────

/** MM's hard cap on channel names. Our generator budget fits inside this. */
export const CHANNEL_NAME_MAX_LENGTH = 64;

/** Matches MM's `TeamNameMinLength`. MM rejects 1-char team slugs server-side. */
export const USERNAME_MIN_LENGTH = 2;

/**
 * Chosen so that the longest generated name exactly fills MM's 64-char cap:
 *   USERNAME_MAX + "-proj-" + PROJECT_ID_MAX + "-" + CUSTOM_CHANNEL_MAX
 *        24     +    6     +       16        +  1  +         17        = 64
 */
export const USERNAME_MAX_LENGTH = 24;

export const PROJECT_ID_MIN_LENGTH = 1;
export const PROJECT_ID_MAX_LENGTH = 16;

export const CUSTOM_CHANNEL_MIN_LENGTH = 1;
export const CUSTOM_CHANNEL_MAX_LENGTH = 17;

/**
 * Lowercase letters + digits, hyphens as internal separators only. No
 * leading, trailing, or double hyphen. Strict subset of MM's
 * `IsValidAlphaNum` (MM allows repeated hyphens and `__` DM-pair markers
 * — we don't).
 */
export const USERNAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Project identifiers + custom channel names — no hyphens, keeps the parser unambiguous. */
export const PROJECT_ID_RE = /^[a-z0-9]+$/;
export const CUSTOM_CHANNEL_RE = /^[a-z0-9]+$/;

// ── Reserved sets ────────────────────────────────────────────────────────────

export const PROJECT_DISCRIMINATOR = 'proj' as const;
export const COMMUNITY_PREFIX = 'community' as const;

/** Reserved channel suffixes for every workspace. Order matters for UI tests. */
export const RESERVED_WORKSPACE_CHANNELS = ['general', 'coach', 'admin'] as const;

/** MM's default system channels — users never own these. */
export const MM_SYSTEM_CHANNELS: ReadonlySet<string> = new Set(['town-square', 'off-topic']);

/**
 * Usernames that would collide with a channel suffix, discriminator, or MM
 * system channel. This is our local list; we do NOT mirror MM's
 * `IsReservedTeamName()` — we let MM reject the team-creation call and
 * surface the error at signup, avoiding a second source of truth.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set<string>([
  ...MM_SYSTEM_CHANNELS,
  ...RESERVED_WORKSPACE_CHANNELS,
  PROJECT_DISCRIMINATOR,
  COMMUNITY_PREFIX,
]);

// ── Validators ───────────────────────────────────────────────────────────────

export function isValidUsername(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length < USERNAME_MIN_LENGTH) return false;
  if (name.length > USERNAME_MAX_LENGTH) return false;
  if (!USERNAME_RE.test(name)) return false;
  if (RESERVED_USERNAMES.has(name)) return false;
  // Any hyphen-delimited segment that collides with a canonical delimiter
  // or reserved channel suffix would create a parsing ambiguity in
  // {username}-based channel names. Example: with the segment-level check
  // off, `foo-proj-bar-general` could parse as either
  // `{foo-proj-bar}-general` (workspace) or `{foo}-proj-bar-general`
  // (project). We reject at validation so every channel name has a
  // single canonical parse. See also deriveJoinedUsernames().
  for (const segment of name.split('-')) {
    if (RESERVED_USERNAMES.has(segment)) return false;
  }
  return true;
}

/**
 * Returns a UI-ready error message for an invalid username, or `null` if
 * the input is valid. Messages are intentionally terse — they render
 * next to the signup field.
 */
export function usernameValidationError(name: unknown): string | null {
  if (typeof name !== 'string' || name === '') return 'Username is required.';
  if (name.length < USERNAME_MIN_LENGTH) {
    return `Username must be at least ${USERNAME_MIN_LENGTH} characters.`;
  }
  if (name.length > USERNAME_MAX_LENGTH) {
    return `Username must be at most ${USERNAME_MAX_LENGTH} characters.`;
  }
  if (!USERNAME_RE.test(name)) {
    return 'Username can only contain lowercase letters, digits, and hyphens (no leading, trailing, or double hyphen).';
  }
  if (RESERVED_USERNAMES.has(name)) {
    return `"${name}" is reserved.`;
  }
  for (const segment of name.split('-')) {
    if (RESERVED_USERNAMES.has(segment)) {
      return `Username cannot contain "${segment}" as a segment (reserved).`;
    }
  }
  return null;
}

export function isValidProjectId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.length < PROJECT_ID_MIN_LENGTH) return false;
  if (id.length > PROJECT_ID_MAX_LENGTH) return false;
  return PROJECT_ID_RE.test(id);
}

export function isValidCustomChannelName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length < CUSTOM_CHANNEL_MIN_LENGTH) return false;
  if (name.length > CUSTOM_CHANNEL_MAX_LENGTH) return false;
  return CUSTOM_CHANNEL_RE.test(name);
}

// ── Channel name generators ──────────────────────────────────────────────────

export function workspaceGeneralChannelName(username: string): string {
  return `${username}-general`;
}

export function workspaceCoachChannelName(username: string): string {
  return `${username}-coach`;
}

export function workspaceAdminChannelName(username: string): string {
  return `${username}-admin`;
}

export function workspaceCustomChannelName(username: string, custom: string): string {
  return `${username}-${custom}`;
}

export function projectGeneralChannelName(username: string, project: string): string {
  return `${username}-${PROJECT_DISCRIMINATOR}-${project}-general`;
}

export function projectChannelName(username: string, project: string, channel: string): string {
  return `${username}-${PROJECT_DISCRIMINATOR}-${project}-${channel}`;
}

// ── Recognizers ──────────────────────────────────────────────────────────────

export function isMmSystemChannel(name: string): boolean {
  return MM_SYSTEM_CHANNELS.has(name);
}

export function isCommunityChannel(name: string): boolean {
  return typeof name === 'string' && name.startsWith(`${COMMUNITY_PREFIX}-`);
}

// ── Parser ───────────────────────────────────────────────────────────────────

export type ParsedChannel =
  | { kind: 'workspace'; username: string; channel: string; reserved: boolean }
  | { kind: 'project'; username: string; project: string; channel: string }
  | { kind: 'community'; name: string }
  | { kind: 'system'; name: string }
  | { kind: 'foreign'; name: string }
  | { kind: 'unknown'; name: string };

/**
 * Parse a MM channel name in the context of a known username.
 *
 * The parser never guesses — callers supply the username. For
 * cross-workspace attribution (admin unread aggregation, discover feed),
 * use `attributeChannelToUsername(name, knownUsernames)` which iterates
 * with longest-prefix-wins semantics.
 */
export function parseChannelName(name: string, username: string): ParsedChannel {
  if (typeof name !== 'string' || name === '') return { kind: 'unknown', name: '' };
  if (isMmSystemChannel(name)) return { kind: 'system', name };
  if (isCommunityChannel(name)) return { kind: 'community', name };

  const prefix = `${username}-`;
  if (!name.startsWith(prefix)) return { kind: 'foreign', name };

  const rest = name.slice(prefix.length);
  if (rest === '') return { kind: 'unknown', name };

  const parts = rest.split('-');

  // Project channel: proj-{project}-{channel} — exactly three segments.
  if (parts.length === 3 && parts[0] === PROJECT_DISCRIMINATOR) {
    const project = parts[1];
    const channel = parts[2];
    const channelIsReserved = (RESERVED_WORKSPACE_CHANNELS as readonly string[]).includes(channel);
    if (isValidProjectId(project) && (channelIsReserved || isValidCustomChannelName(channel))) {
      return { kind: 'project', username, project, channel };
    }
    return { kind: 'unknown', name };
  }

  // Workspace channel: exactly one segment (reserved or custom, both no-hyphen).
  if (parts.length === 1) {
    const channel = parts[0];
    const reserved = (RESERVED_WORKSPACE_CHANNELS as readonly string[]).includes(channel);
    if (reserved || isValidCustomChannelName(channel)) {
      return { kind: 'workspace', username, channel, reserved };
    }
  }

  return { kind: 'unknown', name };
}

/**
 * Attribute a channel to one of a known set of usernames. Returns the
 * owning username, or `null` for system/community/foreign/unknown.
 *
 * Resolves prefix-ambiguous usernames (e.g. `kyle` vs `kyle-x`) by picking
 * the longest match first — critical for admin aggregation where both
 * could plausibly own the same channel name root.
 */
export function attributeChannelToUsername(
  name: string,
  usernames: readonly string[],
): string | null {
  if (typeof name !== 'string' || name === '') return null;
  const byLength = [...usernames].sort((a, b) => b.length - a.length);
  for (const u of byLength) {
    const parsed = parseChannelName(name, u);
    if (parsed.kind === 'workspace' || parsed.kind === 'project') return u;
  }
  return null;
}

/**
 * Derive the set of workspace usernames a user is FULL-MEMBER joined to,
 * based on the MM channel list alone. Signal: presence of
 * `{username}-general|coach|admin` ({@link RESERVED_WORKSPACE_CHANNELS}).
 *
 * **Full-membership only.** Project-only guest collaborations (being in
 * someone's `{owner}-proj-*` without joining their workspace) are
 * deliberately NOT surfaced here. Callers that want both — e.g. the
 * unread aggregator which rolls project-only guest unreads under the
 * owner's key — should use {@link deriveContactedUsernames}.
 *
 * This distinction matters because the return feeds
 * `deriveAppShellWorkspaces` → the MenuBar tile list, and the "bug #3"
 * callout on that function explicitly forbids project-only guests from
 * appearing as workspace tiles.
 *
 * Community channels, MM system channels, DMs, custom workspace
 * channels, and project channels are ignored. Pure — no Firestore,
 * no known-usernames list required. Returns a sorted list with
 * `ownUsername` excluded.
 */
export function deriveJoinedUsernames(
  channels: ReadonlyArray<{ name: string; type: string }>,
  ownUsername: string | null,
): string[] {
  const usernames = new Set<string>();
  const projectMarker = `-${PROJECT_DISCRIMINATOR}-`;
  for (const ch of channels) {
    if (ch.type === 'D') continue;
    const name = ch.name ?? '';
    for (const suffix of RESERVED_WORKSPACE_CHANNELS) {
      const marker = `-${suffix}`;
      if (!name.endsWith(marker) || name.length <= marker.length) continue;
      const candidate = name.slice(0, -marker.length);
      if (candidate.includes(projectMarker)) break;
      if (!isValidUsername(candidate)) break;
      usernames.add(candidate);
      break;
    }
  }
  if (ownUsername) usernames.delete(ownUsername);
  return Array.from(usernames).sort();
}

/**
 * Derive the set of OTHER builder usernames a user has ANY relationship
 * with — full workspace members AND project-only guest collaborators.
 *
 * Two signals, unioned:
 *   1. Full workspace membership (same signal as {@link deriveJoinedUsernames}).
 *   2. Project-only membership — presence of `{username}-proj-{project}-*`
 *      channels marks `{username}` as a builder whose project the user is
 *      in, even when the user hasn't joined the containing workspace.
 *      `-proj-` is a unique delimiter because `proj` is reserved in
 *      {@link RESERVED_USERNAMES} — `isValidUsername` enforces that no
 *      segment of a username equals `proj`, so a real username cannot
 *      embed `-proj-` as a segment break.
 *
 * Callers:
 *   - `aggregateUnreadByContext` → roll project-only unreads under the
 *      owner's `workspace:{slug}` bucket.
 *   - `categorize` / `groupByCategory` callers that want full
 *      `guest-project` bucketing.
 *
 * Do NOT use this for the MenuBar tile list — see deriveJoinedUsernames.
 *
 * Returns a sorted list with `ownUsername` excluded.
 */
export function deriveContactedUsernames(
  channels: ReadonlyArray<{ name: string; type: string }>,
  ownUsername: string | null,
): string[] {
  const usernames = new Set<string>(deriveJoinedUsernames(channels, ownUsername));
  const projectMarker = `-${PROJECT_DISCRIMINATOR}-`;
  for (const ch of channels) {
    if (ch.type === 'D') continue;
    const name = ch.name ?? '';
    const projIdx = name.indexOf(projectMarker);
    if (projIdx <= 0) continue;
    const candidate = name.slice(0, projIdx);
    if (!isValidUsername(candidate)) continue;
    const parsed = parseChannelName(name, candidate);
    if (parsed.kind === 'project') usernames.add(candidate);
  }
  if (ownUsername) usernames.delete(ownUsername);
  return Array.from(usernames).sort();
}
