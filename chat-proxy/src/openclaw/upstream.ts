import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  signConnectDevice,
  type DeviceIdentity,
} from "./device-identity.js";

export type UpstreamErrorCode =
  | "connect-failed"
  | "auth-failed"
  | "timeout"
  | "invalid-response";

export class UpstreamError extends Error {
  override readonly name = "UpstreamError";
  constructor(
    readonly code: UpstreamErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// Openclaw 2026.5.12 bumped the gateway WS handshake protocol from 3
// to 4 (the gateway sends `expectedProtocol=4, minimumProbeProtocol=4`
// and closes with code 1002 otherwise). Keep in sync with
// `scripts/lib/gateway-rpc.ts` PROTOCOL_VERSION.
//
// Wire-surface depended on by Phase 7 (ACTIVITY-STREAM-SPEC §Phase 7
// R7-C): the `session.message` / `sessions.changed` payload spread
// (`totalTokens`, `contextTokens`, `totalTokensFresh`) and per-message
// `usage` / `cost` / `model` are parsed by `session-telemetry.ts`. On
// every OC base-image roll, re-verify these field names alongside this
// bump — a silent rename degrades the context meter, not the handshake.
const PROTOCOL_VERSION = 4;
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
    await waitForOpen(ws, timeoutMs);
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

    await sendRequest(
      ws,
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

function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try {
        ws.terminate();
      } catch {
        /* */
      }
      reject(
        new UpstreamError("connect-failed", `WS open timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      try {
        ws.terminate();
      } catch {
        /* */
      }
      reject(new UpstreamError("connect-failed", `WS open failed: ${err.message}`));
    };
    function cleanup() {
      clearTimeout(timer);
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onError);
    }
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

function startConnectChallengeTracker(ws: WebSocket): {
  wait: (timeoutMs: number) => Promise<string>;
} {
  let cached: string | null = null;
  let pendingResolve: ((nonce: string) => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;

  const onMessage = (data: unknown) => {
    if (cached !== null) return;
    let parsed: unknown;
    try {
      parsed =
        typeof data === "string"
          ? JSON.parse(data)
          : JSON.parse((data as Buffer).toString("utf-8"));
    } catch {
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { type?: unknown }).type !== "event" ||
      (parsed as { event?: unknown }).event !== "connect.challenge"
    ) {
      return;
    }
    const nonce = (parsed as { payload?: { nonce?: unknown } }).payload?.nonce;
    if (typeof nonce !== "string" || nonce.length === 0) {
      const err = new UpstreamError(
        "invalid-response",
        "connect.challenge event has no string nonce",
      );
      if (pendingReject) pendingReject(err);
      return;
    }
    cached = nonce;
    if (pendingResolve) pendingResolve(nonce);
  };
  ws.on("message", onMessage);

  return {
    wait(timeoutMs: number): Promise<string> {
      if (cached !== null) return Promise.resolve(cached);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(
            new UpstreamError(
              "connect-failed",
              `connect.challenge not received within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        const onClose = () => {
          cleanup();
          reject(
            new UpstreamError(
              "connect-failed",
              "socket closed before connect.challenge arrived",
            ),
          );
        };
        pendingResolve = (nonce) => {
          cleanup();
          resolve(nonce);
        };
        pendingReject = (err) => {
          cleanup();
          reject(err);
        };
        function cleanup() {
          clearTimeout(timer);
          ws.removeListener("close", onClose);
          pendingResolve = null;
          pendingReject = null;
        }
        ws.on("close", onClose);
      });
    },
  };
}

interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

function isResponseFrame(v: unknown): v is ResponseFrame {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { type?: unknown }).type === "res" &&
    typeof (v as { id?: unknown }).id === "string" &&
    typeof (v as { ok?: unknown }).ok === "boolean"
  );
}

async function sendRequest(
  ws: WebSocket,
  method: string,
  params: unknown,
  timeoutMs: number,
  mapConnectErrors = false,
): Promise<unknown> {
  const id = randomUUID();
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new UpstreamError("timeout", `${method} response timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onMessage = (data: unknown) => {
      let parsed: unknown;
      try {
        parsed =
          typeof data === "string"
            ? JSON.parse(data)
            : JSON.parse((data as Buffer).toString("utf-8"));
      } catch {
        return;
      }
      if (!isResponseFrame(parsed) || parsed.id !== id) return;
      cleanup();
      if (parsed.ok) {
        resolve(parsed.payload);
      } else {
        const msg = parsed.error?.message ?? "unknown gateway error";
        const code: UpstreamErrorCode = mapConnectErrors ? "auth-failed" : "invalid-response";
        reject(new UpstreamError(code, msg));
      }
    };

    const onClose = () => {
      cleanup();
      reject(
        new UpstreamError(
          mapConnectErrors ? "auth-failed" : "connect-failed",
          `${method}: socket closed before response`,
        ),
      );
    };
    const onError = (err: Error) => {
      cleanup();
      reject(
        new UpstreamError(
          mapConnectErrors ? "auth-failed" : "connect-failed",
          `${method}: socket error before response: ${err.message}`,
        ),
      );
    };

    function cleanup() {
      clearTimeout(timer);
      ws.removeListener("message", onMessage);
      ws.removeListener("close", onClose);
      ws.removeListener("error", onError);
    }

    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.on("error", onError);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}
