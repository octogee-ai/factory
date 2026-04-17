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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { log as defaultLog } from "./config.js";
import {
  loadOrCreateDeviceIdentity,
  signConnectDevice,
  type DeviceIdentity,
} from "./gateway-device-identity.js";

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

/** Per-phase timing + outcome trace emitted on every connect attempt. */
export interface ConnectTrace {
  url: string;
  /** Last phase entered. On failure this is where we got stuck. */
  stage: "ws-open" | "challenge" | "connect" | "done";
  success: boolean;
  /** ms in TCP connect + WS upgrade ("open" event). */
  wsOpenMs?: number;
  /** ms waiting for the server's `connect.challenge` event after open. */
  challengeMs?: number;
  /** ms from sending `connect` frame to receiving `hello-ok`. */
  connectMs?: number;
  /** ms total (new WebSocket() → either success or error). */
  totalMs: number;
  /** Present on failure — mirrors the thrown GatewayRpcError. */
  errorCode?: GatewayRpcErrorCode;
  errorMessage?: string;
}

export interface GatewayRpcClientOptions {
  /** Default: `ws://127.0.0.1:${OPENCLAW_GATEWAY_PORT || 18789}`. */
  url?: string;
  /**
   * Gateway auth token. Resolution order when omitted:
   *   1. `OPENCLAW_GATEWAY_TOKEN` env var
   *   2. `gateway.auth.token` field of the local openclaw.json (found via
   *      `openclawConfigPath` below, or the default location)
   *   3. empty string (auth is skipped — the gateway will reject if it
   *      requires token-mode auth)
   *
   * Reading the config file is what makes this work on a stock OpenClaw
   * gateway deployment without any extra env-var plumbing: the token is
   * already the source of truth on disk.
   */
  token?: string;
  /**
   * Path to `openclaw.json` to read the token from when the env var is
   * unset. Default: `OPENCLAW_CONFIG` (i.e. `~/.openclaw/openclaw.json`).
   * Primarily for tests; production callers leave this unset.
   */
  openclawConfigPath?: string;
  /**
   * Structured trace callback for per-phase connect timings. Fires once per
   * connect attempt (successful or not) with ms elapsed in each phase:
   *   - `wsOpenMs`:    TCP+WS-upgrade handshake
   *   - `challengeMs`: time waiting for server's `connect.challenge` event
   *   - `connectMs`:   time from sending `connect` frame to receiving hello-ok
   *   - `totalMs`:     wall-clock total
   * `stage` names the last phase entered; on failure, it's whichever phase
   * was in flight (`ws-open`, `challenge`, `connect`). Default: emit a
   * single-line log via `scripts/lib/config.log`. Tests inject a spy.
   */
  onConnectTrace?: (trace: ConnectTrace) => void;
  /** TCP connect + handshake budget. Default: 10_000ms. */
  connectTimeoutMs?: number;
  /** Per-request response budget. Default: 10_000ms. */
  callTimeoutMs?: number;
  /**
   * Pre-loaded Ed25519 device identity for signing the connect challenge.
   * Default: lazy-load via `loadOrCreateDeviceIdentity()` (path controlled
   * by `OCTOGEE_PROVISIONER_IDENTITY_PATH` env or the default under
   * $HOME/.octogee/provisioner/). Pass explicitly in tests to avoid touching
   * the disk.
   */
  identity?: DeviceIdentity;
  /**
   * Scopes to request from the gateway. Default: ["operator.admin"] which
   * the server expands to admin+read+write per `shared/device-auth.ts`. If
   * a specific caller only needs read-only access, narrow this to
   * ["operator.read"] and the server will grant only that.
   */
  scopes?: string[];
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
  const token = resolveGatewayToken(opts);
  // 10s for connect — matches the handshake budget from the first hotfix and
  // accommodates the gateway's startup-grace window on a cold pod. Callers
  // who need a tighter budget (readiness probes) still set it explicitly.
  //
  // 30s for per-call — `config.get` on a busy/startup gateway has been
  // observed taking up to ~21s because plugin init pins the event loop
  // (April 16 TEST signup: 21411ms server-side). 10s was too tight and
  // caused the provisioner to fall back to file-write on cold pods, which
  // in turn caused chokidar to miss the write and the new customer's coach
  // to never start. 30s is cheap headroom for the rare cold-call case;
  // on a stable gateway the round-trip is sub-second.
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  const scopes = opts.scopes ?? ["operator.admin"];
  // Default trace: single-line log when a connect takes >500ms or fails.
  // Keeps warm-path noise low while still catching every slow/failed
  // connect for diagnosis. Tests inject a spy to capture every trace.
  const onConnectTrace =
    opts.onConnectTrace ??
    ((trace: ConnectTrace) => {
      if (trace.success && trace.totalMs < 500) return;
      const phases = [
        trace.wsOpenMs !== undefined ? `wsOpen=${trace.wsOpenMs}ms` : null,
        trace.challengeMs !== undefined ? `challenge=${trace.challengeMs}ms` : null,
        trace.connectMs !== undefined ? `connect=${trace.connectMs}ms` : null,
      ]
        .filter(Boolean)
        .join(" ");
      const outcome = trace.success
        ? "OK"
        : `FAIL stage=${trace.stage} ${trace.errorCode}: ${trace.errorMessage}`;
      defaultLog(`[rpc-trace] ${outcome} total=${trace.totalMs}ms ${phases} url=${trace.url}`);
    });

  // Lazy identity load: only when we actually need to connect. Tests inject
  // `identity` directly so they never touch the real filesystem.
  let identity: DeviceIdentity | null = opts.identity ?? null;
  function resolveIdentity(): DeviceIdentity {
    if (identity) return identity;
    identity = loadOrCreateDeviceIdentity();
    return identity;
  }

  async function call(method: string, params: unknown): Promise<unknown> {
    const ws = await openAndConnect({
      url,
      token,
      connectTimeoutMs,
      identity: resolveIdentity(),
      scopes,
      onConnectTrace,
    });
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
        const ws = await openAndConnect({
          url,
          token,
          connectTimeoutMs: t,
          identity: resolveIdentity(),
          scopes,
          onConnectTrace,
        });
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

// ── Auth-token resolution ───────────────────────────────────────────────────

/**
 * Three-tier token resolution: explicit opt → env var → openclaw.json on
 * disk. The on-disk fallback is what makes this work on a vanilla OpenClaw
 * gateway deployment — inside a pod the config file IS the source of
 * truth (the gateway's own `auth.token` config field), and the provisioner
 * runs with read access to it. No extra env-var plumbing in the helm chart,
 * no extra Secret Manager entry.
 *
 * Silently falls back to empty string on any read / parse error; the server
 * will then reject the connect with `token_missing` and the applyConfigPatch
 * orchestrator will fall back to file-write. Better than throwing here,
 * which would abort every provisioning call — we want RPC to be best-effort.
 */
function resolveGatewayToken(opts: GatewayRpcClientOptions): string {
  if (typeof opts.token === "string" && opts.token.length > 0) return opts.token;
  const fromEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return readTokenFromOpenClawJson(opts.openclawConfigPath);
}

function readTokenFromOpenClawJson(configPath?: string): string {
  const resolved = configPath ?? path.join(os.homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = fs.readFileSync(resolved, "utf8");
    const parsed = JSON.parse(raw) as {
      gateway?: { auth?: { token?: unknown } };
    };
    const token = parsed?.gateway?.auth?.token;
    if (typeof token === "string" && token.length > 0) return token;
  } catch {
    // Treated as "no token available" — caller either passes one explicitly
    // or the connect will fail with token_missing and fall back to file-write.
  }
  return "";
}

// ── Connect handshake ───────────────────────────────────────────────────────

const PROTOCOL_VERSION = 3;

interface OpenAndConnectParams {
  url: string;
  token: string;
  connectTimeoutMs: number;
  identity: DeviceIdentity;
  scopes: string[];
  onConnectTrace?: (trace: ConnectTrace) => void;
}

async function openAndConnect(params: OpenAndConnectParams): Promise<WebSocket> {
  // Instrumentation: record per-phase elapsed times so we can see which phase
  // stalled on event-loop-pinned gateways. Each phase's duration is filled in
  // as we cross it; `stage` advances so the final trace names where we are.
  const t0 = Date.now();
  let wsOpenMs: number | undefined;
  let challengeMs: number | undefined;
  let connectMs: number | undefined;
  let stage: ConnectTrace["stage"] = "ws-open";

  const emitTrace = (success: boolean, err?: GatewayRpcError) => {
    if (!params.onConnectTrace) return;
    params.onConnectTrace({
      url: params.url,
      stage: success ? "done" : stage,
      success,
      wsOpenMs,
      challengeMs,
      connectMs,
      totalMs: Date.now() - t0,
      errorCode: err?.code,
      errorMessage: err?.message,
    });
  };

  const ws = new WebSocket(params.url);

  // Permanent swallow-listener. `ws.terminate()` on a still-connecting socket
  // emits an async `'error'` event ("WebSocket was closed before the
  // connection was established"); if our specific-error listener has already
  // been removed (cleanup after reject), Node treats it as unhandled and
  // kills the process. Attaching a no-op at creation time guarantees the
  // event always has at least one listener for the life of the socket.
  // Regression: fix/gateway-rpc-crash-and-scopes — April 16 TEST signup
  // crashed the provisioner here.
  ws.on("error", () => {});

  // Start capturing the `connect.challenge` event NOW, before waiting for
  // `open`. OpenClaw sends the challenge as soon as the server accepts the
  // WS upgrade, which can race our handler-attachment (`ws` does not buffer
  // messages across listener gaps). Mirrors OpenClaw's
  // `trackConnectChallengeNonce` test helper.
  const nonceTracker = startConnectChallengeTracker(ws);

  try {
    // ── Phase 1: TCP connect + WS upgrade ───────────────────────────────
    const wsOpenStart = Date.now();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(
          new GatewayRpcError("connect-failed", `WS open timed out after ${params.connectTimeoutMs}ms`),
        );
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
    wsOpenMs = Date.now() - wsOpenStart;

    // ── Phase 2: receive server's connect.challenge event ───────────────
    stage = "challenge";
    const challengeStart = Date.now();
    const nonce = await nonceTracker.wait(params.connectTimeoutMs);
    challengeMs = Date.now() - challengeStart;

    // ── Phase 3: send signed connect, await hello-ok ────────────────────
    // OpenClaw's shared-token auth path: the server pushes a
    // `connect.challenge` event with a one-shot nonce as soon as the WS
    // opens, and the client's connect frame must include a device signature
    // over the nonce (per OpenClaw `server.auth.default-token.suite.ts`).
    // Without this, the server grants zero scopes and every subsequent call
    // returns `missing scope: operator.read`.
    stage = "connect";
    const clientInfo = {
      id: "gateway-client" as const,
      displayName: "octogee-provisioner" as const,
      version: "1.0.0" as const,
      platform: process.platform,
      mode: "backend" as const,
    };
    const device = signConnectDevice({
      identity: params.identity,
      clientId: clientInfo.id,
      clientMode: clientInfo.mode,
      role: "operator",
      scopes: params.scopes,
      nonce,
      token: params.token || null,
      platform: clientInfo.platform,
    });
    const connectStart = Date.now();
    await sendRequest(
      ws,
      "connect",
      {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: clientInfo,
        role: "operator",
        scopes: params.scopes,
        device,
        ...(params.token ? { auth: { token: params.token } } : {}),
      },
      params.connectTimeoutMs,
      /* mapConnectErrors */ true,
    );
    connectMs = Date.now() - connectStart;

    emitTrace(true);
  } catch (err) {
    try {
      ws.terminate();
    } catch {
      // ignore
    }
    emitTrace(false, err instanceof GatewayRpcError ? err : undefined);
    throw err;
  }

  return ws;
}

/**
 * Capture the server's `{type: "event", event: "connect.challenge",
 * payload: {nonce}}` push. Must attach BEFORE the WS opens because the
 * server emits the challenge the instant it accepts the upgrade, and `ws`
 * does not buffer messages received before a listener is attached.
 *
 * Returns `{ wait(timeoutMs) }` which resolves with the nonce as soon as it
 * arrives (or immediately if it's already cached), and rejects on timeout
 * or socket close.
 */
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
      const err = new GatewayRpcError(
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
            new GatewayRpcError(
              "connect-failed",
              `connect.challenge not received within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        const onClose = () => {
          cleanup();
          reject(
            new GatewayRpcError(
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

