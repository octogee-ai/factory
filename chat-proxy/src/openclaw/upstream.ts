/**
 * Long-lived upstream WebSocket to an OpenClaw gateway.
 *
 * Ports just the handshake half of `scripts/lib/gateway-rpc.ts`
 * (`openAndConnect` + `sendRequest` + challenge tracker) without the
 * short-lived RPC client wrapper. Returns an authenticated `WebSocket`
 * ready for bidirectional frame relay.
 *
 * The three-phase dance, mirrored byte-for-byte from OpenClaw's protocol:
 *   1. TCP connect + WS upgrade.
 *   2. Capture the server-pushed `connect.challenge` event (nonce).
 *   3. Send signed `connect` request frame with token + scopes; await
 *      `hello-ok` response.
 *
 * Listeners attach BEFORE `open` fires because OpenClaw emits the challenge
 * the instant it accepts the upgrade, and the `ws` library does not buffer
 * messages across listener gaps.
 */
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  signConnectDevice,
  type DeviceIdentity,
} from "./device-identity.js";

// ── Errors ─────────────────────────────────────────────────────────────────

export type UpstreamErrorCode =
  /** Socket never opened (DNS / refused / timeout before open). */
  | "connect-failed"
  /** Gateway rejected the `connect` frame (bad/missing token). */
  | "auth-failed"
  /** Request exceeded timeout without a response. */
  | "timeout"
  /** Server replied with a shape we couldn't parse. */
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

// ── Public surface ─────────────────────────────────────────────────────────

const PROTOCOL_VERSION = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export interface OpenUpstreamParams {
  /** Gateway URL, e.g. `http://octogee-gateway-gw-a.octogee-test.svc.cluster.local:18789`. */
  url: string;
  /** OPENCLAW_GATEWAY_TOKEN — resolved from env before calling. */
  token: string;
  /** Ed25519 device identity for signing the challenge nonce. */
  identity: DeviceIdentity;
  /** Operator scopes to request. Default: ["operator.admin"]. */
  scopes?: string[];
  /** ms for every phase (open + challenge + connect). Default 30s. */
  timeoutMs?: number;
}

/**
 * Open a WebSocket to the gateway, complete the device-auth handshake,
 * and return the authenticated socket ready for bidirectional relay.
 * Throws `UpstreamError` on any phase failure.
 */
export async function openUpstream(params: OpenUpstreamParams): Promise<WebSocket> {
  const scopes = params.scopes ?? ["operator.admin"];
  const timeoutMs = params.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  // URL comes in as http(s)://; ws library accepts ws(s):// so convert.
  const wsUrl = params.url.replace(/^http/, "ws");
  const ws = new WebSocket(wsUrl);

  // Permanent swallow-listener prevents node from crashing on an async
  // `error` during cleanup of a still-connecting socket.
  ws.on("error", () => {});

  // Start capturing the challenge BEFORE open — OpenClaw emits it the
  // instant it accepts the upgrade, which races our post-open attach.
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
      /* mapConnectErrors */ true,
    );

    return ws;
  } catch (err) {
    try {
      ws.terminate();
    } catch {
      // ignore
    }
    throw err;
  }
}

// ── Phase helpers ──────────────────────────────────────────────────────────

function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try {
        ws.terminate();
      } catch {
        // ignore
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
        // ignore
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

// ── Request/response envelope (only used for the `connect` call) ───────────

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

    // If the socket closes or errors before a response arrives, fail the
    // pending request immediately instead of waiting out the full timeout
    // (previously up to 30s of dead waiting during handshake failures).
    // Mirrors scripts/lib/gateway-rpc.ts's sendRequest wiring.
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
