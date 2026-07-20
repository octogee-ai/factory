import type { WebSocket } from "ws";

import type { DeviceIdentity } from "@octogee/shared/types/device-identity";

import { getOpenClawDeviceIdentity } from "./device-identity.js";
import {
  clearGatewayDeviceToken,
  fetchGatewayAuth,
  invalidateGatewayToken,
  persistGatewayDeviceToken,
  type FetchGatewayAuthOptions,
  type GatewayOpenClawAuth,
} from "./gateway-token.js";
import {
  OpenclawWireError,
  openUpstream,
  type OpenUpstreamParams,
} from "./upstream.js";

export interface AuthenticatedUpstreamDeps {
  fetchGatewayAuth(opts: FetchGatewayAuthOptions): Promise<GatewayOpenClawAuth>;
  openUpstream(params: OpenUpstreamParams): Promise<WebSocket>;
  clearGatewayDeviceToken(): Promise<void>;
  invalidateGatewayToken(gatewayId: string): void;
  persistGatewayDeviceToken(opts: { token: string }): Promise<void>;
  getIdentity(): DeviceIdentity;
}

const productionDeps: AuthenticatedUpstreamDeps = {
  fetchGatewayAuth,
  openUpstream,
  clearGatewayDeviceToken,
  invalidateGatewayToken,
  persistGatewayDeviceToken,
  getIdentity: getOpenClawDeviceIdentity,
};

export interface AuthenticatedUpstreamOptions {
  gatewayId: string;
  url: string;
  timeoutMs?: number;
}

async function connect(
  opts: AuthenticatedUpstreamOptions,
  auth: GatewayOpenClawAuth,
  deps: AuthenticatedUpstreamDeps,
): Promise<WebSocket> {
  return deps.openUpstream({
    url: opts.url,
    token: auth.token,
    deviceToken: auth.deviceToken,
    identity: deps.getIdentity(),
    timeoutMs: opts.timeoutMs,
    onDeviceToken: async (issued) => {
      await deps.persistGatewayDeviceToken({ token: issued.deviceToken });
    },
  });
}

async function rotateAuth(
  gatewayId: string,
  stale: GatewayOpenClawAuth,
  deps: AuthenticatedUpstreamDeps,
): Promise<GatewayOpenClawAuth> {
  if (stale.source === "legacy-token") {
    deps.invalidateGatewayToken(gatewayId);
  } else {
    await deps.clearGatewayDeviceToken();
  }
  return deps.fetchGatewayAuth({
    gatewayId,
    allowLegacyFallback: true,
    skipCache: true,
  });
}

export async function openAuthenticatedUpstream(
  opts: AuthenticatedUpstreamOptions,
  deps: AuthenticatedUpstreamDeps = productionDeps,
): Promise<WebSocket> {
  const initial = await deps.fetchGatewayAuth({
    gatewayId: opts.gatewayId,
    allowLegacyFallback: true,
  });
  try {
    return await connect(opts, initial, deps);
  } catch (error) {
    if (!(error instanceof OpenclawWireError) || error.code !== "auth-failed") throw error;
  }
  const fresh = await rotateAuth(opts.gatewayId, initial, deps);
  return connect(opts, fresh, deps);
}
