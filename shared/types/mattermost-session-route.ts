import { parseAgentId } from './identity.js';

export type MattermostSessionPeerKind = 'channel' | 'group' | 'direct';

export interface MattermostSessionRoute {
  agentId: string;
  peerKind: MattermostSessionPeerKind;
  primaryChannelId: string;
  threadRootPostId?: string;
}

export interface ThreadedMattermostSessionRoute extends MattermostSessionRoute {
  peerKind: 'group' | 'direct';
  threadRootPostId: string;
}

export interface ChannelScopedMattermostSessionRoute extends MattermostSessionRoute {
  peerKind: 'channel' | 'group';
  threadRootPostId?: never;
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
    (route.peerKind !== 'group' && route.peerKind !== 'direct') ||
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
