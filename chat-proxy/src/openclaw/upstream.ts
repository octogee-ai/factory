import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { OPENCLAW_PROTOCOL_VERSION } from "../../../shared/types/openclaw-wire.js";
import {
  startConnectChallengeTracker,
  waitForWsOpen,
  sendWsRequest,
} from "../../../shared/types/openclaw-wire-core.js";
import {
  signConnectDevice,
  type DeviceIdentity,
} from "../../../shared/types/device-identity.js";

export {
  OpenclawWireError,
  type OpenclawWireErrorCode,
} from "../../../shared/types/openclaw-wire-core.js";

// Wire-surface depended on by Phase 7 (ACTIVITY-STREAM-SPEC §Phase 7
// R7-C): the `session.message` / `sessions.changed` payload spread
// (`totalTokens`, `contextTokens`, `totalTokensFresh`) and per-message
// `usage` / `cost` / `model` are parsed by `session-telemetry.ts`. On
// every OC base-image roll, re-verify these field names alongside the
// shared OPENCLAW_PROTOCOL_VERSION bump — a silent rename degrades the
// context meter, not the handshake.
const PROTOCOL_VERSION = OPENCLAW_PROTOCOL_VERSION;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * The full operator scope set used by OpenClaw's control UI
 * (`ui/src/ui/gateway.ts:154` CONTROL_UI_OPERATOR_SCOPES). Mirroring it here
 * because asking for just `operator.admin` left the bridge unable to receive
 * `agent` broadcast frames in TEST — `agent` events have READ_SCOPE in
 * `server-broadcast.ts:22 EVENT_SCOPE_GUARDS`, and the connect handshake's
 * `scope-upgrade` gate (`message-handler.ts:1194-1215`) will downgrade scopes
 * to empty when the persisted device's `approvedScopes` doesn't satisfy
 * `roleScopesAllow`. Once empty, `hasEventScope` rejects every broadcast.
 * The control UI works because it requests all five up front so the device
 * pairing record is approved with the full set.
 */
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

