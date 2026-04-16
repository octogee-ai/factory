/**
 * Minimal WS JSON-RPC client for the local OpenClaw gateway.
 *
 * Talks the same framed protocol the Control UI uses (see
 * `~/workspace/openclaw/openclaw/src/gateway/protocol/schema/frames.ts`):
 *
 *   → { type: "req", id, method: "connect", params: ConnectParams }
 *   ← { type: "res", id, ok: true, payload: { type: "hello-ok", … } }
 *   → { type: "req", id, method: "config.patch", params: { raw, baseHash } }
 *   ← { type: "res", id, ok: true, payload: { ok, noop, path, config } }
 *
 * Short-lived connections by design. Each `configGet` / `configPatch` /
 * `channelsStatus` / `isGatewayUp` call opens a WS, does the connect
 * handshake, issues one request, then closes. That matches the provisioner's
 * use pattern (one RPC per signup step) and sidesteps all the lifecycle
 * concerns of a long-lived client. If/when a caller starts issuing many
 * requests in a tight loop, we'd add pooling here — not today.
 *
 * Error surface is a single `GatewayRpcError` with a typed `code`; the
 * caller uses the code (not the server-message text) to decide fallback
 * behavior. See `applyConfigPatch` in `./config.ts` for the retry + file-
 * write fallback ceremony built on top.
 */

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

// ── Public API ──────────────────────────────────────────────────────────────

export type GatewayRpcErrorCode =
  /** Socket never opened (DNS / refused / net). */
  | "connect-failed"
  /** Gateway rejected the `connect` frame (bad/missing token). */
  | "auth-failed"
  /** `config.patch` failed because `baseHash` didn't match the server's snapshot. */
  | "hash-mismatch"
  /** `config.patch` failed schema/validation on the server. */
  | "invalid-patch"
  /** Request exceeded `callTimeoutMs` without a response. */
  | "timeout"
  /** Server replied with a shape we couldn't parse or an unexpected error. */
  | "invalid-response"
  /** Catch-all for unmapped server errors. */
  | "rpc-error";

export class GatewayRpcError extends Error {
  override readonly name = "GatewayRpcError";
  constructor(
    readonly code: GatewayRpcErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface GatewayRpcClientOptions {
  /** Default: `ws://127.0.0.1:${OPENCLAW_GATEWAY_PORT || 18789}`. */
  url?: string;
  /** Default: `OPENCLAW_GATEWAY_TOKEN`. */
  token?: string;
  /** TCP connect + handshake budget. Default: 3000ms. */
  connectTimeoutMs?: number;
  /** Per-request response budget. Default: 5000ms. */
  callTimeoutMs?: number;
}

export interface ConfigGetResult {
  /** The redacted-but-structurally-complete config snapshot. Sensitive values
   *  may appear as placeholder strings — the gateway restores them when the
   *  merge-patch is applied server-side. */
  config: unknown;
  /** sha256 of the on-disk raw config. Pass to `configPatch` as `baseHash`. */
  hash: string;
}

export interface ConfigPatchResult {
  ok: true;
  /** True when the patch matched the current state and no write happened. */
  noop?: boolean;
  path?: string;
  /** The post-patch (still-redacted) config echoed by the server. */
  config?: unknown;
}

export interface GatewayRpcClient {
  configGet(): Promise<ConfigGetResult>;
  configPatch(patch: object, baseHash: string): Promise<ConfigPatchResult>;
  channelsStatus(): Promise<unknown>;
  /** Cheap up-probe: completes the handshake + a `channels.status` roundtrip
   *  within `timeoutMs`. Never throws. */
  isGatewayUp(timeoutMs?: number): Promise<boolean>;
  /** No-op in short-lived mode; kept for API stability. */
  close(): Promise<void>;
}

export function createGatewayRpc(opts: GatewayRpcClientOptions = {}): GatewayRpcClient {
  const url =
    opts.url ??
    `ws://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || 18789}`;
  const token = opts.token ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  const connectTimeoutMs = opts.connectTimeoutMs ?? 3000;
  const callTimeoutMs = opts.callTimeoutMs ?? 5000;

  async function call(method: string, params: unknown): Promise<unknown> {
    const ws = await openAndConnect({ url, token, connectTimeoutMs });
    try {
      return await sendRequest(ws, method, params, callTimeoutMs);
    } finally {
      try {
        ws.close();
      } catch {
        // Socket may already be closed — nothing to do.
      }
    }
  }

  return {
    async configGet() {
      const payload = await call("config.get", {});
      const snap = payload as { hash?: unknown; config?: unknown } | undefined;
      if (!snap || typeof snap !== "object") {
        throw new GatewayRpcError("invalid-response", "config.get returned non-object payload");
      }
      if (typeof snap.hash !== "string" || snap.hash.length === 0) {
        throw new GatewayRpcError("invalid-response", "config.get payload missing `hash`");
      }
      return { config: snap.config, hash: snap.hash };
    },

    async configPatch(patch, baseHash) {
      try {
        const payload = await call("config.patch", {
          raw: JSON.stringify(patch),
          baseHash,
        });
        if (!payload || typeof payload !== "object") {
          throw new GatewayRpcError("invalid-response", "config.patch returned non-object payload");
        }
        const p = payload as ConfigPatchResult;
        if (p.ok !== true) {
          throw new GatewayRpcError("invalid-response", "config.patch payload missing `ok: true`");
        }
        return p;
      } catch (err) {
        // Remap known INVALID_REQUEST messages to specific codes so the
        // `applyConfigPatch` orchestrator can tell "retry me" from "give up".
        if (err instanceof GatewayRpcError && err.code === "rpc-error") {
          const msg = err.message.toLowerCase();
          if (msg.includes("config changed since last load") || msg.includes("base hash")) {
            throw new GatewayRpcError("hash-mismatch", err.message, err.details);
          }
          if (msg.includes("invalid config")) {
            throw new GatewayRpcError("invalid-patch", err.message, err.details);
          }
        }
        throw err;
      }
    },

    async channelsStatus() {
      return await call("channels.status", {});
    },

    async isGatewayUp(timeoutMs) {
      const t = timeoutMs ?? connectTimeoutMs;
      try {
        const ws = await openAndConnect({ url, token, connectTimeoutMs: t });
        try {
          await sendRequest(ws, "channels.status", {}, t);
          return true;
        } finally {
          try {
            ws.close();
          } catch {
            // Socket may already be closed — nothing to do.
          }
        }
      } catch {
        return false;
      }
    },

    async close() {
      // Short-lived connections — nothing persistent to close.
    },
  };
}

// ── Connect handshake ───────────────────────────────────────────────────────

const PROTOCOL_VERSION = 3;

interface OpenAndConnectParams {
  url: string;
  token: string;
  connectTimeoutMs: number;
}

async function openAndConnect(params: OpenAndConnectParams): Promise<WebSocket> {
  const ws = new WebSocket(params.url);

  // Wait for socket-open OR net failure, whichever comes first.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      reject(new GatewayRpcError("connect-failed", `WS open timed out after ${params.connectTimeoutMs}ms`));
    }, params.connectTimeoutMs);
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
      reject(new GatewayRpcError("connect-failed", `WS open failed: ${err.message}`));
    };
    function cleanup() {
      clearTimeout(timer);
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onError);
    }
    ws.once("open", onOpen);
    ws.once("error", onError);
  });

  // Protocol handshake: send `connect`, expect hello-ok.
  try {
    await sendRequest(
      ws,
      "connect",
      {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          version: "1.0.0",
          platform: process.platform,
          mode: "backend",
        },
        ...(params.token ? { auth: { token: params.token } } : {}),
      },
      params.connectTimeoutMs,
      /* mapConnectErrors */ true,
    );
  } catch (err) {
    try {
      ws.terminate();
    } catch {
      // ignore
    }
    throw err;
  }

  return ws;
}

// ── Request/response envelope ───────────────────────────────────────────────

interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
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
      reject(new GatewayRpcError("timeout", `${method} response timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onMessage = (data: unknown) => {
      let parsed: unknown;
      try {
        parsed =
          typeof data === "string"
            ? JSON.parse(data)
            : JSON.parse((data as Buffer).toString("utf-8"));
      } catch {
        // Not our frame; keep waiting.
        return;
      }
      if (!isResponseFrame(parsed) || parsed.id !== id) return;

      cleanup();
      if (parsed.ok) {
        resolve(parsed.payload);
        return;
      }
      const errCode = parsed.error?.code ?? "UNKNOWN";
      const errMsg = parsed.error?.message ?? "gateway error";
      if (mapConnectErrors) {
        // connect-time failures become `auth-failed` so callers can branch.
        reject(new GatewayRpcError("auth-failed", errMsg, { serverCode: errCode, details: parsed.error?.details }));
        return;
      }
      reject(new GatewayRpcError("rpc-error", errMsg, { serverCode: errCode, details: parsed.error?.details }));
    };
    const onClose = () => {
      cleanup();
      reject(new GatewayRpcError("connect-failed", `socket closed before ${method} response`));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(new GatewayRpcError("connect-failed", `socket error during ${method}: ${err.message}`));
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

