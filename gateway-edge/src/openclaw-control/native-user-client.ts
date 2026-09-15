import { assertWorkspaceIdentityReady } from "@octogee/core/openclaw-workspace-bootstrap";
import { deriveDeviceIdentity } from "@octogee/shared/types/device-identity";
import { openClawDeviceSubject, openClawProxyIdentityHeaders, openClawProxyOrigin } from "@octogee/shared/types/openclaw-proxy-identity";
import { attachUpstreamRpcClient } from "../chat-proxy/openclaw/bridge-upstream-rpc.js";
import { openProxyIdentitySocket, podClientAddress } from "./proxy-identity.js";
import { openClawControlUpstreamBase } from "./surface.js";

export async function openNativeUserClient(uid: string, gatewayId: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.OPENCLAW_CONTROL_IDENTITY !== "per-user" || env.GATEWAY_CLASS !== "builder" || env.GATEWAY_ID !== gatewayId) {
    throw new Error("Native workspace permissions require the local per-user Builder gateway");
  }
  const secret = env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!secret) throw new Error("OPENCLAW_GATEWAY_TOKEN is required");
  const url = new URL("/", openClawControlUpstreamBase(env)); url.protocol = "ws:";
  const headers = (user: string) => ({ ...openClawProxyIdentityHeaders({ user, clientAddress: podClientAddress() }), origin: openClawProxyOrigin(env) });
  assertWorkspaceIdentityReady(env);
  let scopes: string[] = [];
  const ws = await openProxyIdentitySocket({ url, headers: headers(uid), timeoutMs: 5000,
    identity: deriveDeviceIdentity({ secret, subject: openClawDeviceSubject(gatewayId, uid) }),
    onScopes: value => { scopes = value; },
  });
  const rpc = attachUpstreamRpcClient(ws, { timeoutMs: 5000 });
  return { scopes: new Set(scopes), call: rpc.call, close: () => { rpc.dispose(); ws.close(); } };
}
