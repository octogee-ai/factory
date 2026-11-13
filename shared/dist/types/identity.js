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
export const PROJECT_DISCRIMINATOR = 'proj';
export const COMMUNITY_PREFIX = 'community';
export const RESERVED_WORKSPACE_CHANNELS = ['general', 'coach', 'admin'];
export const MM_SYSTEM_CHANNELS = new Set(['town-square', 'off-topic']);
export const RESERVED_USERNAMES = new Set([
    ...MM_SYSTEM_CHANNELS,
    ...RESERVED_WORKSPACE_CHANNELS,
    PROJECT_DISCRIMINATOR,
    COMMUNITY_PREFIX,
]);
export const RESERVED_MATTERMOST_TEAM_PREFIXES = [
    'admin',
    'api',
    'channel',
    'claim',
    'error',
    'files',
    'help',
    'landing',
    'login',
    'mfa',
    'oauth',
    'plug',
    'plugins',
    'post',
    'signup',
    'boards',
    'playbooks',
];
export function isValidUsername(name) {
    if (typeof name !== 'string')
        return false;
    if (name.length < USERNAME_MIN_LENGTH)
        return false;
    if (name.length > USERNAME_MAX_LENGTH)
        return false;
    if (!USERNAME_RE.test(name))
        return false;
    if (RESERVED_USERNAMES.has(name))
        return false;
    if (RESERVED_MATTERMOST_TEAM_PREFIXES.some((prefix) => name.startsWith(prefix)))
        return false;
    for (const segment of name.split('-')) {
        if (RESERVED_USERNAMES.has(segment))
            return false;
    }
    return true;
}
export function usernameValidationError(name) {
    if (typeof name !== 'string' || name === '')
        return 'Username is required.';
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
    if (RESERVED_MATTERMOST_TEAM_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        return 'Username starts with a reserved chat workspace name.';
    }
    for (const segment of name.split('-')) {
        if (RESERVED_USERNAMES.has(segment)) {
            return `Username cannot contain "${segment}" as a segment (reserved).`;
        }
    }
    return null;
}
export function isValidProjectId(id) {
    if (typeof id !== 'string')
        return false;
    if (id.length < PROJECT_ID_MIN_LENGTH)
        return false;
    if (id.length > PROJECT_ID_MAX_LENGTH)
        return false;
    return PROJECT_ID_RE.test(id);
}
export function isValidCustomChannelName(name) {
    if (typeof name !== 'string')
        return false;
    if (name.length < CUSTOM_CHANNEL_MIN_LENGTH)
        return false;
    if (name.length > CUSTOM_CHANNEL_MAX_LENGTH)
        return false;
    return CUSTOM_CHANNEL_RE.test(name);
}
export function workspaceGeneralChannelName(username) {
    return `${username}-general`;
}
export function workspaceDefaultAgentChannelName(username) {
    return `${username}-coach`;
}
export function workspaceAdminChannelName(username) {
    return `${username}-admin`;
}
export function workspaceCustomChannelName(username, custom) {
    return `${username}-${custom}`;
}
export function projectGeneralChannelName(username, project) {
    return `${username}-${PROJECT_DISCRIMINATOR}-${project}-general`;
}
export function projectChannelName(username, project, channel) {
    return `${username}-${PROJECT_DISCRIMINATOR}-${project}-${channel}`;
}
export function isMmSystemChannel(name) {
    return MM_SYSTEM_CHANNELS.has(name);
}
export const AGENT_ID_PREFIX = 'octogee-';
export const AGENT_ID_SUFFIX = '-coach';
export function workspaceDefaultAgentId(username) {
    return `${AGENT_ID_PREFIX}${username}${AGENT_ID_SUFFIX}`;
}
export function projectAgentId(username, project) {
    return `${AGENT_ID_PREFIX}${username}-${PROJECT_DISCRIMINATOR}-${project}${AGENT_ID_SUFFIX}`;
}
export function workspaceDefaultAgentMmUsername(username) {
    return `${username}${AGENT_ID_SUFFIX}`;
}
export function projectAgentMmUsername(username, project) {
    return `${username}-${PROJECT_DISCRIMINATOR}-${project}${AGENT_ID_SUFFIX}`;
}
export function parseAgentId(id) {
    const unknown = { kind: 'unknown', id };
    if (typeof id !== 'string')
        return { kind: 'unknown', id: '' };
    if (!id.startsWith(AGENT_ID_PREFIX) || !id.endsWith(AGENT_ID_SUFFIX))
        return unknown;
    const body = id.slice(AGENT_ID_PREFIX.length, -AGENT_ID_SUFFIX.length);
    if (body === '')
        return unknown;
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
    if (!isValidUsername(username) || !isValidProjectId(project))
        return unknown;
    return { kind: 'project', username, project };
}
export function isCommunityChannel(name) {
    return typeof name === 'string' && name.startsWith(`${COMMUNITY_PREFIX}-`);
}
export function parseChannelName(name, username) {
    if (typeof name !== 'string' || name === '')
        return { kind: 'unknown', name: '' };
    if (isMmSystemChannel(name))
        return { kind: 'system', name };
    if (isCommunityChannel(name))
        return { kind: 'community', name };
    const prefix = `${username}-`;
    if (!name.startsWith(prefix))
        return { kind: 'foreign', name };
    const rest = name.slice(prefix.length);
    if (rest === '')
        return { kind: 'unknown', name };
    const parts = rest.split('-');
    if (parts.length === 3 && parts[0] === PROJECT_DISCRIMINATOR) {
        const project = parts[1];
        const channel = parts[2];
        const channelIsReserved = RESERVED_WORKSPACE_CHANNELS.includes(channel);
        if (isValidProjectId(project) && (channelIsReserved || isValidCustomChannelName(channel))) {
            return { kind: 'project', username, project, channel };
        }
        return { kind: 'unknown', name };
    }
    if (parts.length === 1) {
        const channel = parts[0];
        const reserved = RESERVED_WORKSPACE_CHANNELS.includes(channel);
        if (reserved || isValidCustomChannelName(channel)) {
            return { kind: 'workspace', username, channel, reserved };
        }
    }
    return { kind: 'unknown', name };
}
export function attributeChannelToUsername(name, usernames) {
    if (typeof name !== 'string' || name === '')
        return null;
    const byLength = [...usernames].sort((a, b) => b.length - a.length);
    for (const u of byLength) {
        const parsed = parseChannelName(name, u);
        if (parsed.kind === 'workspace' || parsed.kind === 'project')
            return u;
    }
    return null;
}
export function deriveJoinedUsernames(channels, ownUsername) {
    const usernames = new Set();
    const projectMarker = `-${PROJECT_DISCRIMINATOR}-`;
    for (const ch of channels) {
        if (ch.type === 'D')
            continue;
        const name = ch.name ?? '';
        for (const suffix of RESERVED_WORKSPACE_CHANNELS) {
            const marker = `-${suffix}`;
            if (!name.endsWith(marker) || name.length <= marker.length)
                continue;
            const candidate = name.slice(0, -marker.length);
            if (candidate.includes(projectMarker))
                break;
            if (!isValidUsername(candidate))
                break;
            usernames.add(candidate);
            break;
        }
    }
    if (ownUsername)
        usernames.delete(ownUsername);
    return Array.from(usernames).sort();
}
export function deriveContactedUsernames(channels, ownUsername) {
    const usernames = new Set(deriveJoinedUsernames(channels, ownUsername));
    const projectMarker = `-${PROJECT_DISCRIMINATOR}-`;
    for (const ch of channels) {
        if (ch.type === 'D')
            continue;
        const name = ch.name ?? '';
        const projIdx = name.indexOf(projectMarker);
        if (projIdx <= 0)
            continue;
        const candidate = name.slice(0, projIdx);
        if (!isValidUsername(candidate))
            continue;
        const parsed = parseChannelName(name, candidate);
        if (parsed.kind === 'project')
            usernames.add(candidate);
    }
    if (ownUsername)
        usernames.delete(ownUsername);
    return Array.from(usernames).sort();
}
export function mattermostAccountIdForAgentId(agentId) {
    const parsed = parseAgentId(agentId);
    if (parsed.kind === 'coach')
        return `${parsed.username}-coach`;
    if (parsed.kind === 'project')
        return `${parsed.username}-proj-${parsed.project}`;
    return null;
}
