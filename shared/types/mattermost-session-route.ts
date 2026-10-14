import { parseAgentId } from './identity.js';

export type MattermostSessionPeerKind = 'channel' | 'group' | 'direct';

export interface MattermostThreadSelection { channelId: string; threadRootPostId: string }
export function isMattermostPostId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]{26}$/u.test(value);
}
export function isMattermostThreadSelection(value: unknown): value is MattermostThreadSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).every(key => key === 'channelId' || key === 'threadRootPostId') &&
    isMattermostPostId(body.channelId) && isMattermostPostId(body.threadRootPostId);
}

export interface MattermostSessionRoute {
  agentId: string;
  peerKind: MattermostSessionPeerKind;
  primaryChannelId: string;
  threadRootPostId?: string;
}

export interface ThreadedMattermostSessionRoute extends MattermostSessionRoute {
  peerKind: MattermostSessionPeerKind;
  threadRootPostId: string;
}

export interface ChannelScopedMattermostSessionRoute extends MattermostSessionRoute {
  peerKind: 'channel' | 'group';
  threadRootPostId?: never;
}

export interface ThreadedChannelMattermostSessionRoute extends ThreadedMattermostSessionRoute {
  peerKind: 'channel' | 'group';
}

const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;

export function parseMattermostSessionRoute(sessionKey: unknown): MattermostSessionRoute | null {
  if (typeof sessionKey !== 'string') return null;
  const parts = sessionKey.split(':');
  if (parts.length !== 5 && parts.length !== 7) return null;

  const [agentPrefix, agentId, provider, peerKind, primaryChannelId, threadMarker, root] = parts;
  if (
    agentPrefix !== 'agent' ||
    !agentId ||
    provider !== 'mattermost' ||
    (peerKind !== 'channel' && peerKind !== 'group' && peerKind !== 'direct') ||
    !primaryChannelId
  ) {
    return null;
  }
  if (parts.length === 7 && (threadMarker !== 'thread' || !root)) return null;

  return {
    agentId,
    peerKind,
    primaryChannelId,
    ...(root ? { threadRootPostId: root } : {}),
  };
}

export function parseThreadedMattermostSessionRoute(
  sessionKey: unknown,
): ThreadedMattermostSessionRoute | null {
  const route = parseMattermostSessionRoute(sessionKey);
  if (
    !route ||
    !MATTERMOST_ID_RE.test(route.primaryChannelId) ||
    !route.threadRootPostId ||
    !MATTERMOST_ID_RE.test(route.threadRootPostId) ||
    parseAgentId(route.agentId).kind === 'unknown'
  ) {
    return null;
  }
  return {
    agentId: route.agentId,
    peerKind: route.peerKind,
    primaryChannelId: route.primaryChannelId,
    threadRootPostId: route.threadRootPostId,
  };
}

export function parseThreadedChannelMattermostSessionRoute(sessionKey: unknown): ThreadedChannelMattermostSessionRoute | null {
  const route = parseThreadedMattermostSessionRoute(sessionKey);
  return route && route.peerKind !== 'direct' ? { ...route, peerKind: route.peerKind } : null;
}

export function parseChannelScopedMattermostSessionRoute(
  sessionKey: unknown,
): ChannelScopedMattermostSessionRoute | null {
  const route = parseMattermostSessionRoute(sessionKey);
  if (
    !route ||
    (route.peerKind !== 'channel' && route.peerKind !== 'group') ||
    !MATTERMOST_ID_RE.test(route.primaryChannelId) ||
    route.threadRootPostId !== undefined ||
    parseAgentId(route.agentId).kind === 'unknown'
  ) {
    return null;
  }
  return {
    agentId: route.agentId,
    peerKind: route.peerKind,
    primaryChannelId: route.primaryChannelId,
  };
}
