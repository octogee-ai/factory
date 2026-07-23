
export const CHANNEL_NAME_MAX_LENGTH = 64;

export const USERNAME_MIN_LENGTH = 2;

export const USERNAME_MAX_LENGTH = 24;

export const PROJECT_ID_MIN_LENGTH = 1;
export const PROJECT_ID_MAX_LENGTH = 16;

export const CUSTOM_CHANNEL_MIN_LENGTH = 1;
export const CUSTOM_CHANNEL_MAX_LENGTH = 17;

export const USERNAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const PROJECT_ID_RE = /^[a-z0-9]+$/;
export const CUSTOM_CHANNEL_RE = /^[a-z0-9]+$/;

export const PROJECT_DISCRIMINATOR = 'proj' as const;
export const COMMUNITY_PREFIX = 'community' as const;

export const RESERVED_WORKSPACE_CHANNELS = ['general', 'coach', 'admin'] as const;

export const MM_SYSTEM_CHANNELS: ReadonlySet<string> = new Set(['town-square', 'off-topic']);

export const RESERVED_USERNAMES: ReadonlySet<string> = new Set<string>([
  ...MM_SYSTEM_CHANNELS,
  ...RESERVED_WORKSPACE_CHANNELS,
  PROJECT_DISCRIMINATOR,
  COMMUNITY_PREFIX,
]);

export function isValidUsername(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length < USERNAME_MIN_LENGTH) return false;
  if (name.length > USERNAME_MAX_LENGTH) return false;
  if (!USERNAME_RE.test(name)) return false;
  if (RESERVED_USERNAMES.has(name)) return false;
  for (const segment of name.split('-')) {
    if (RESERVED_USERNAMES.has(segment)) return false;
  }
  return true;
}

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

export function isMmSystemChannel(name: string): boolean {
  return MM_SYSTEM_CHANNELS.has(name);
}

export const AGENT_ID_PREFIX = 'octogee-' as const;
export const AGENT_ID_SUFFIX = '-coach' as const;

export function workspaceCoachAgentId(username: string): string {
  return `${AGENT_ID_PREFIX}${username}${AGENT_ID_SUFFIX}`;
}

export function projectAgentId(username: string, project: string): string {
  return `${AGENT_ID_PREFIX}${username}-${PROJECT_DISCRIMINATOR}-${project}${AGENT_ID_SUFFIX}`;
}

export function workspaceCoachMmUsername(username: string): string {
  return `${username}${AGENT_ID_SUFFIX}`;
}

export function projectAgentMmUsername(username: string, project: string): string {
  return `${username}-${PROJECT_DISCRIMINATOR}-${project}${AGENT_ID_SUFFIX}`;
}

export type ParsedAgentId =
  | { kind: 'coach'; username: string }
  | { kind: 'project'; username: string; project: string }
  | { kind: 'unknown'; id: string };

export function parseAgentId(id: string): ParsedAgentId {
  const unknown: ParsedAgentId = { kind: 'unknown', id };
  if (typeof id !== 'string') return { kind: 'unknown', id: '' };
  if (!id.startsWith(AGENT_ID_PREFIX) || !id.endsWith(AGENT_ID_SUFFIX)) return unknown;
  const body = id.slice(AGENT_ID_PREFIX.length, -AGENT_ID_SUFFIX.length);
  if (body === '') return unknown;

  // `proj` is a reserved username segment, so `-proj-` appears at most once
  // and only as the project discriminator — hyphenated usernames stay
  // unambiguous.
  const marker = `-${PROJECT_DISCRIMINATOR}-`;
  const markerIdx = body.indexOf(marker);
  if (markerIdx === -1) {
    return isValidUsername(body) ? { kind: 'coach', username: body } : unknown;
  }
  const username = body.slice(0, markerIdx);
  const project = body.slice(markerIdx + marker.length);
  if (!isValidUsername(username) || !isValidProjectId(project)) return unknown;
  return { kind: 'project', username, project };
}

export function isCommunityChannel(name: string): boolean {
  return typeof name === 'string' && name.startsWith(`${COMMUNITY_PREFIX}-`);
}

export type ParsedChannel =
  | { kind: 'workspace'; username: string; channel: string; reserved: boolean }
  | { kind: 'project'; username: string; project: string; channel: string }
  | { kind: 'community'; name: string }
  | { kind: 'system'; name: string }
  | { kind: 'foreign'; name: string }
  | { kind: 'unknown'; name: string };

export function parseChannelName(name: string, username: string): ParsedChannel {
  if (typeof name !== 'string' || name === '') return { kind: 'unknown', name: '' };
  if (isMmSystemChannel(name)) return { kind: 'system', name };
  if (isCommunityChannel(name)) return { kind: 'community', name };

  const prefix = `${username}-`;
  if (!name.startsWith(prefix)) return { kind: 'foreign', name };

  const rest = name.slice(prefix.length);
  if (rest === '') return { kind: 'unknown', name };

  const parts = rest.split('-');

  if (parts.length === 3 && parts[0] === PROJECT_DISCRIMINATOR) {
    const project = parts[1];
    const channel = parts[2];
    const channelIsReserved = (RESERVED_WORKSPACE_CHANNELS as readonly string[]).includes(channel);
    if (isValidProjectId(project) && (channelIsReserved || isValidCustomChannelName(channel))) {
      return { kind: 'project', username, project, channel };
    }
    return { kind: 'unknown', name };
  }

  if (parts.length === 1) {
    const channel = parts[0];
    const reserved = (RESERVED_WORKSPACE_CHANNELS as readonly string[]).includes(channel);
    if (reserved || isValidCustomChannelName(channel)) {
      return { kind: 'workspace', username, channel, reserved };
    }
  }

  return { kind: 'unknown', name };
}

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
