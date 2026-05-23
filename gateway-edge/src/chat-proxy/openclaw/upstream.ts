import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { OPENCLAW_PROTOCOL_VERSION } from "../../../../shared/types/openclaw-wire.js";
import {
  startConnectChallengeTracker,
  waitForWsOpen,
  sendWsRequest,
} from "../../../../shared/types/openclaw-wire-core.js";
import {
  signConnectDevice,
  type DeviceIdentity,
} from "../../../../shared/types/device-identity.js";

export {
  OpenclawWireError,
  type OpenclawWireErrorCode,
} from "../../../../shared/types/openclaw-wire-core.js";

const PROTOCOL_VERSION = OPENCLAW_PROTOCOL_VERSION;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

const DEFAULT_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
] as const;

export interface OpenUpstreamParams {
  url: string;
  token: string;
  identity: DeviceIdentity;
  scopes?: string[];
  timeoutMs?: number;
}

export async function openUpstream(params: OpenUpstreamParams): Promise<WebSocket> {
  const scopes = params.scopes ?? [...DEFAULT_OPERATOR_SCOPES];
  const timeoutMs = params.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const wsUrl = params.url.replace(/^http/, "ws");
  const ws = new WebSocket(wsUrl);

  ws.on("error", () => {});

  const nonceTracker = startConnectChallengeTracker(ws);

  try {
    await waitForWsOpen(ws, timeoutMs);
    const nonce = await nonceTracker.wait(timeoutMs);

    const clientInfo = {
      id: "gateway-client" as const,
      displayName: "octogee-chat-proxy" as const,
      version: "1.0.0" as const,
      platform: process.platform,
      mode: "backend" as const,
    };
    const device = signConnectDevice({
      identity: params.identity,
      clientId: clientInfo.id,
      clientMode: clientInfo.mode,
      role: "operator",
      scopes,
      nonce,
      token: params.token || null,
      platform: clientInfo.platform,
    });

    await sendWsRequest(
      ws,
      randomUUID(),
      "connect",
      {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: clientInfo,
        role: "operator",
        scopes,
        device,
        ...(params.token ? { auth: { token: params.token } } : {}),
      },
      timeoutMs,
      true,
    );

    return ws;
  } catch (err) {
    try {
      ws.terminate();
    } catch {
      /* */
    }
    throw err;
  }
}

