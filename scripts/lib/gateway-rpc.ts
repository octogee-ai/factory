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

export type GatewayRpcErrorCode =
  | "connect-failed"
  | "auth-failed"
  | "hash-mismatch"
  | "invalid-patch"
  | "timeout"
  | "invalid-response"
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

export interface ConnectTrace {
  url: string;
  stage: "ws-open" | "challenge" | "connect" | "done";
  success: boolean;
  wsOpenMs?: number;
  challengeMs?: number;
  connectMs?: number;
  totalMs: number;
  errorCode?: GatewayRpcErrorCode;
  errorMessage?: string;
}

export interface GatewayRpcClientOptions {
  url?: string;
  token?: string;
  openclawConfigPath?: string;
  onConnectTrace?: (trace: ConnectTrace) => void;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  identity?: DeviceIdentity;
  scopes?: string[];
}

export interface ConfigGetResult {
  config: unknown;
  hash: string;
}

export interface ConfigPatchResult {
  ok: true;
  noop?: boolean;
  path?: string;
  config?: unknown;
  /**
   * Post-write sha256 of the canonical config bytes. Populated by the octogee
   * fork patch (see openclaw fork branch) so callers can pipeline subsequent
   * patches without re-fetching `config.get`. Undefined on stock OpenClaw or
   * older fork builds.
   */
  hash?: string;
}

export interface SecretsReloadResult {
  warningCount?: number;
  ok?: boolean;
}

export interface CronAddSpec {
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  agentId?: string;
  sessionKey?: string;
  schedule: { kind: "at"; at: string } | { kind: "every"; everyMs: number } | { kind: "cron"; expr: string; tz?: string };
  sessionTarget: "main" | "isolated" | "current" | `session:${string}`;
  wakeMode: "now" | "next-heartbeat";
  payload:
    | { kind: "systemEvent"; text: string }
    | {
        kind: "agentTurn";
        message: string;
        model?: string;
        thinking?: string;
        timeoutSeconds?: number;
        lightContext?: boolean;
        toolsAllow?: string[];
      };
  delivery?: {
    mode: "none" | "announce" | "webhook";
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
    bestEffort?: boolean;
  };
}

export interface CronAddResult {
  id: string;
  [extra: string]: unknown;
}

export interface GatewayRpcClient {
  configGet(): Promise<ConfigGetResult>;
  configPatch(patch: object, baseHash: string): Promise<ConfigPatchResult>;
  channelsStatus(): Promise<unknown>;
  secretsReload(): Promise<SecretsReloadResult>;
  cronAdd(spec: CronAddSpec): Promise<CronAddResult>;
  isGatewayUp(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export function createGatewayRpc(opts: GatewayRpcClientOptions = {}): GatewayRpcClient {
  const url =
    opts.url ??
    `ws://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || 18789}`;
  const token = resolveGatewayToken(opts);
  const connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
  const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  const scopes = opts.scopes ?? ["operator.admin"];
  const traceVerbose = /^(1|true|yes|debug)$/i.test(process.env.OCTOGEE_RPC_TRACE_VERBOSE ?? "");
  const slowTraceMs = Number.parseInt(process.env.OCTOGEE_RPC_TRACE_SLOW_MS ?? "5000", 10);
  const failureSampleMs = Number.parseInt(process.env.OCTOGEE_RPC_TRACE_FAILURE_SAMPLE_MS ?? "30000", 10);
  let lastFailureKey = "";
  let lastFailureLogAt = 0;
  let suppressedFailures = 0;

  function formatConnectTrace(trace: ConnectTrace): string {
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
    return `[rpc-trace] ${outcome} total=${trace.totalMs}ms ${phases} url=${trace.url}`;
  }

  const onConnectTrace =
    opts.onConnectTrace ??
    ((trace: ConnectTrace) => {
      if (traceVerbose) {
        defaultLog(formatConnectTrace(trace));
        return;
      }

      if (trace.success) {
        if (suppressedFailures > 0) {
          defaultLog(`${formatConnectTrace(trace)} (recovered after ${suppressedFailures} suppressed failures)`);
          suppressedFailures = 0;
          lastFailureKey = "";
        } else if (trace.totalMs >= slowTraceMs) {
          defaultLog(formatConnectTrace(trace));
        }
        return;
      }

      const now = Date.now();
      const failureKey = `${trace.stage}:${trace.errorCode}:${trace.errorMessage ?? ""}`;
      const shouldLog =
        failureKey !== lastFailureKey ||
        lastFailureLogAt === 0 ||
        now - lastFailureLogAt >= failureSampleMs;

      if (shouldLog) {
        const suffix = suppressedFailures > 0 ? ` (suppressed ${suppressedFailures} similar failures)` : "";
        defaultLog(`${formatConnectTrace(trace)}${suffix}`);
        lastFailureKey = failureKey;
        lastFailureLogAt = now;
        suppressedFailures = 0;
      } else {
        suppressedFailures++;
      }
    });

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
      } catch { /* */ }
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

    async cronAdd(spec) {
      const payload = await call("cron.add", spec);
      if (!payload || typeof payload !== "object") {
        throw new GatewayRpcError("invalid-response", "cron.add returned non-object payload");
      }
      const p = payload as { id?: unknown };
      if (typeof p.id !== "string" || p.id.length === 0) {
        throw new GatewayRpcError("invalid-response", "cron.add payload missing string `id`");
      }
      return payload as CronAddResult;
    },

    async secretsReload() {
      const payload = await call("secrets.reload", {});
      if (!payload || typeof payload !== "object") {
        throw new GatewayRpcError(
          "invalid-response",
          "secrets.reload returned non-object payload",
        );
      }
      const p = payload as { ok?: unknown; warningCount?: unknown };
      if (p.warningCount !== undefined && typeof p.warningCount !== "number") {
        throw new GatewayRpcError(
          "invalid-response",
          `secrets.reload payload.warningCount must be a number when present (got ${typeof p.warningCount})`,
        );
      }
      if (p.ok !== undefined && typeof p.ok !== "boolean") {
        throw new GatewayRpcError(
          "invalid-response",
          `secrets.reload payload.ok must be a boolean when present (got ${typeof p.ok})`,
        );
      }
      return p as SecretsReloadResult;
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
          ws.close();
        } catch { /* */ }
        return true;
      } catch {
        return false;
      }
    },

    async close() {},
  };
}

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
  } catch { /* */ }
  return "";
}

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

  ws.on("error", () => {});

  const nonceTracker = startConnectChallengeTracker(ws);

  try {
    const wsOpenStart = Date.now();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try {
          ws.terminate();
        } catch { /* */ }
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
        } catch { /* */ }
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

    stage = "challenge";
    const challengeStart = Date.now();
    const nonce = await nonceTracker.wait(params.connectTimeoutMs);
    challengeMs = Date.now() - challengeStart;

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
      true,
    );
    connectMs = Date.now() - connectStart;

    emitTrace(true);
  } catch (err) {
    try {
      ws.terminate();
    } catch { /* */ }
    emitTrace(false, err instanceof GatewayRpcError ? err : undefined);
    throw err;
  }

  return ws;
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
      } catch { return; }
      if (!isResponseFrame(parsed) || parsed.id !== id) return;

      cleanup();
      if (parsed.ok) {
        resolve(parsed.payload);
        return;
      }
      const errCode = parsed.error?.code ?? "UNKNOWN";
      const errMsg = parsed.error?.message ?? "gateway error";
      if (mapConnectErrors) {
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

