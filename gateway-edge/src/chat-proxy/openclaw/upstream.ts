import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { OPENCLAW_PROTOCOL_VERSION } from "@octogee/shared/types/openclaw-wire";
import {
  startConnectChallengeTracker,
  waitForWsOpen,
  sendWsRequest,
} from "@octogee/shared/types/openclaw-wire-core";
import {
  signConnectDevice,
  type DeviceIdentity,
} from "@octogee/shared/types/device-identity";

export {
  OpenclawWireError,
  type OpenclawWireErrorCode,
} from "@octogee/shared/types/openclaw-wire-core";

const PROTOCOL_VERSION = OPENCLAW_PROTOCOL_VERSION;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

const DEFAULT_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
] as const;

export interface OpenUpstreamParams {
  url: string;
  token?: string;
  deviceToken?: string;
  identity: DeviceIdentity;
  scopes?: string[];
  timeoutMs?: number;
  onDeviceToken?: (auth: { deviceToken: string; role?: string; scopes?: string[] }) => void | Promise<void>;
}

type UpstreamAuth = { deviceToken: string } | { token: string } | undefined;

function authForParams(params: OpenUpstreamParams): UpstreamAuth {
  if (params.deviceToken) return { deviceToken: params.deviceToken };
  if (params.token) return { token: params.token };
  return undefined;
}

function tokenForDeviceSignature(params: OpenUpstreamParams): string | null {
  return params.deviceToken || params.token || null;
}

function helloAuthInfo(helloOk: unknown):
  | { deviceToken?: unknown; role?: unknown; scopes?: unknown }
  | undefined {
  return helloOk && typeof helloOk === "object"
    ? (helloOk as { auth?: { deviceToken?: unknown; role?: unknown; scopes?: unknown } }).auth
    : undefined;
}

async function emitDeviceToken(
  params: OpenUpstreamParams,
  helloOk: unknown,
): Promise<void> {
  const authInfo = helloAuthInfo(helloOk);
  if (typeof authInfo?.deviceToken !== "string" || !authInfo.deviceToken.trim()) return;
  await params.onDeviceToken?.({
    deviceToken: authInfo.deviceToken,
    role: typeof authInfo.role === "string" ? authInfo.role : undefined,
    scopes: Array.isArray(authInfo.scopes)
      ? authInfo.scopes.filter((scope): scope is string => typeof scope === "string")
      : undefined,
  });
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
      token: tokenForDeviceSignature(params),
      platform: clientInfo.platform,
    });
    const auth = authForParams(params);

    const helloOk = await sendWsRequest({
      ws,
      id: randomUUID(),
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: clientInfo,
        role: "operator",
        scopes,
        device,
        ...(auth ? { auth } : {}),
      },
      timeoutMs,
      mapConnectErrors: true,
    });
    await emitDeviceToken(params, helloOk);

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
