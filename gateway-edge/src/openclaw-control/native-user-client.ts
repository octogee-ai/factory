import { assertWorkspaceIdentityReady } from "@octogee/core/openclaw-workspace-bootstrap";
import { deriveDeviceIdentity } from "@octogee/shared/types/device-identity";
import { OPENCLAW_EDGE_SERVICE_IDENTITY, openClawDeviceSubject, openClawProxyIdentityHeaders, openClawProxyOrigin } from "@octogee/shared/types/openclaw-proxy-identity";
import { WebSocket } from "ws";
import { parseChannelScopedMattermostSessionRoute } from "@octogee/shared/types/mattermost-session-route";
import { attachUpstreamRpcClient } from "../chat-proxy/openclaw/bridge-upstream-rpc.js";
import { openProxyIdentitySocket, podClientAddress, profileFor, type OpenClawProfileListItem } from "./proxy-identity.js";
import { openClawControlUpstreamBase } from "./surface.js";
import { synchronizeChannelMembership } from "./channel-membership-sync.js";

export interface NativeUserSocket { ws: WebSocket; scopes: Set<string> }

async function synchronizeConnectedChannelMembership(input: {
  ws: WebSocket;
  uid: string;
  channel: NonNullable<ReturnType<typeof parseChannelScopedMattermostSessionRoute>>;
  url: URL;
  headers: Record<string, string>;
}): Promise<void> {
  const service = await openProxyIdentitySocket({ url: input.url, headers: input.headers, timeoutMs: 5000 });
  const rpc = attachUpstreamRpcClient(service, { timeoutMs: 5000 });
  try {
    const profiles = await rpc.call<{ profiles: OpenClawProfileListItem[] }>("users.list", {});
    if (!profiles.ok) throw new Error(`users.list failed: ${profiles.reason}`);
    const member = profileFor(profiles.result.profiles, input.uid);
    if (!member) throw new Error("Channel membership identity is not initialized");
    if (input.ws.readyState !== WebSocket.OPEN) throw new Error("Native user connection closed during channel synchronization");
    await synchronizeChannelMembership(rpc, input.channel, member.id, true);
    if (input.ws.readyState !== WebSocket.OPEN) throw new Error("Native user connection closed during channel synchronization");
  } finally {
    rpc.dispose();
    service.close();
  }
}

export async function openNativeUserSocket(uid: string, gatewayId: string, env: NodeJS.ProcessEnv = process.env, options: { caps?: readonly string[]; channelSessionKey?: string } = {}): Promise<NativeUserSocket> {
  if (env.OPENCLAW_CONTROL_IDENTITY !== "per-user" || env.GATEWAY_CLASS !== "builder" || env.GATEWAY_ID !== gatewayId) {
    throw new Error("Native workspace permissions require the local per-user Builder gateway");
  }
  const channel = options.channelSessionKey === undefined ? null : parseChannelScopedMattermostSessionRoute(options.channelSessionKey);
  if (options.channelSessionKey !== undefined && !channel) throw new Error("Invalid native channel identity");
  const secret = env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!secret) throw new Error("OPENCLAW_GATEWAY_TOKEN is required");
  const url = new URL("/", openClawControlUpstreamBase(env)); url.protocol = "ws:";
  const headers = (user: string) => ({ ...openClawProxyIdentityHeaders({ user, clientAddress: podClientAddress() }), origin: openClawProxyOrigin(env) });
  assertWorkspaceIdentityReady(env);
  let scopes: string[] = [];
  const ws = await openProxyIdentitySocket({ url, headers: headers(uid), timeoutMs: 5000,
    identity: deriveDeviceIdentity({ secret, subject: openClawDeviceSubject(gatewayId, uid) }),
    onScopes: value => { scopes = value; },
    caps: options.caps,
  });
  try {
    if (channel) {
      await synchronizeConnectedChannelMembership({ ws, uid, channel, url, headers: headers(OPENCLAW_EDGE_SERVICE_IDENTITY) });
    }
    return { ws, scopes: new Set(scopes) };
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

export async function openNativeUserClient(uid: string, gatewayId: string, env: NodeJS.ProcessEnv = process.env) {
  const { ws, scopes } = await openNativeUserSocket(uid, gatewayId, env);
  const rpc = attachUpstreamRpcClient(ws, { timeoutMs: 5000 });
  return { scopes, call: rpc.call, close: () => { rpc.dispose(); ws.close(); } };
}
