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
    await request(rpc, "sessions.channel.sync", {
      agentId: route.agentId, channel: "mattermost", peerKind: route.peerKind,
      peerId: route.primaryChannelId, profileId, member: false,
    });
  }
  for (const row of desired.values()) {
    const route = parseChannelScopedMattermostSessionRoute(row.key)!;
    await request(rpc, "sessions.channel.sync", {
      agentId: route.agentId, channel: "mattermost", peerKind: route.peerKind,
      peerId: route.primaryChannelId, profileId, member: true,
      ...(typeof row.displayName === "string" ? { displayName: row.displayName } : {}),
    });
  }
}
