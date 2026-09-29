import { parseChannelScopedMattermostSessionRoute } from "@octogee/shared/types/mattermost-session-route";

export interface ChannelMembershipRpc {
  call<T>(method: string, params: Record<string, unknown>): Promise<
    { ok: true; result: T } | { ok: false; reason: string }
  >;
}

export interface AuthorizedNativeChannel {
  key: string;
  displayName?: unknown;
}

async function request<T>(rpc: ChannelMembershipRpc, method: string, params: Record<string, unknown>): Promise<T> {
  const response = await rpc.call<T>(method, params);
  if (!response.ok) throw new Error(`${method} failed: ${response.reason}`);
  return response.result;
}

interface ChannelSyncDiagnostics {
  agentId: string;
  channelId: string;
  member: boolean;
  metadataAvailable: boolean;
  channelCreated?: boolean;
  creationSource?: "channel" | "talk" | "operator" | "missing" | "other";
  incognito?: boolean;
  draft?: boolean;
  matchingOrigin?: boolean;
}

export class ChannelMembershipSyncError extends Error {
  constructor(readonly diagnostics: ChannelSyncDiagnostics) {
    super("Native channel membership synchronization failed");
    this.name = "ChannelMembershipSyncError";
  }
}

export async function synchronizeChannelMembership(
  rpc: ChannelMembershipRpc,
  route: NonNullable<ReturnType<typeof parseChannelScopedMattermostSessionRoute>>,
  profileId: string,
  member: boolean,
  displayName?: unknown,
): Promise<void> {
  const result = await rpc.call("sessions.channel.sync", {
    agentId: route.agentId, channel: "mattermost", peerKind: route.peerKind,
    peerId: route.primaryChannelId, profileId, member,
    ...(typeof displayName === "string" ? { displayName } : {}),
  });
  if (result.ok) return;
  const diagnostics: ChannelSyncDiagnostics = {
    agentId: route.agentId, channelId: route.primaryChannelId, member, metadataAvailable: false,
  };
  try {
    const metadata = await rpc.call<{ session: { key?: string; createdVia?: string; incognito?: boolean; visibility?: string;
      origin?: { provider?: string; chatType?: string; nativeChannelId?: string } } | null }>("sessions.describe", {
      key: `agent:${route.agentId}:mattermost:${route.peerKind}:${route.primaryChannelId}`,
      agentId: route.agentId, includeDerivedTitles: false, includeLastMessage: false,
    });
    const session = metadata.ok ? metadata.result?.session : null;
    if (session?.key === `agent:${route.agentId}:mattermost:${route.peerKind}:${route.primaryChannelId}`) {
      diagnostics.metadataAvailable = true;
      diagnostics.channelCreated = session.createdVia === "channel";
      const via = session.createdVia;
      if (via === "channel" || via === "talk" || via === "operator") diagnostics.creationSource = via;
      else diagnostics.creationSource = via === undefined ? "missing" : "other";
      diagnostics.incognito = session.incognito === true;
      diagnostics.draft = session.visibility === "draft";
      if (session.origin) diagnostics.matchingOrigin = session.origin.provider === "mattermost" &&
        session.origin.chatType === route.peerKind && session.origin.nativeChannelId === route.primaryChannelId;
    }
  } catch {
    diagnostics.metadataAvailable = false;
  }
  throw new ChannelMembershipSyncError(diagnostics);
}

export async function synchronizeChannelMemberships(input: {
  rpc: ChannelMembershipRpc;
  profileId: string;
  serviceProfileId: string;
  authorized: readonly AuthorizedNativeChannel[];
}): Promise<void> {
  const { rpc, profileId, serviceProfileId } = input;
  const desired = new Map(input.authorized.map((row) => [row.key, row]));
  if (desired.size !== input.authorized.length) throw new Error("Duplicate authorized channel identity");
  for (const key of desired.keys()) {
    if (!parseChannelScopedMattermostSessionRoute(key)) throw new Error("Invalid authorized channel identity");
  }
  const native = await request<{ sessions: { key: string }[]; hasMore?: boolean }>(rpc, "sessions.list", {
    archived: "all", limit: 10_000, includeUnknown: true,
  });
  if (!Array.isArray(native.sessions) || native.hasMore === true) {
    throw new Error("Native channel membership directory is incomplete");
  }
  const removals: ReturnType<typeof parseChannelScopedMattermostSessionRoute>[] = [];
  for (const row of native.sessions) {
    const route = parseChannelScopedMattermostSessionRoute(row.key);
    if (!route || desired.has(row.key)) continue;
    const evidence = await request<{ members: { identityId: string; addedBy?: string }[] }>(rpc,
      "session.members.listEvidence", { sessionKey: row.key, agentId: route.agentId });
    if (!Array.isArray(evidence.members)) throw new Error("Invalid native channel membership evidence");
    if (evidence.members.some((member) => member.identityId === profileId && member.addedBy === serviceProfileId)) {
      removals.push(route);
    }
  }
  for (const route of removals) {
    if (!route) continue;
    await synchronizeChannelMembership(rpc, route, profileId, false);
  }
  for (const row of desired.values()) {
    const route = parseChannelScopedMattermostSessionRoute(row.key)!;
    await synchronizeChannelMembership(rpc, route, profileId, true, row.displayName);
  }
}
