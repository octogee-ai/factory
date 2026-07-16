import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { OPENCLAW_PROTOCOL_VERSION } from "@octogee/shared/types/openclaw-wire";
import {
  OpenclawWireError,
  type OpenclawWireErrorCode,
  startConnectChallengeTracker,
  waitForWsOpen,
  sendWsRequest,
} from "@octogee/shared/types/openclaw-wire-core";
import { log as defaultLog } from "./config.js";
import {
  loadOrCreateDeviceIdentity,
  signConnectDevice,
  type DeviceIdentity,
} from "./gateway-device-identity.js";

export {
  OpenclawWireError,
  type OpenclawWireErrorCode,
} from "@octogee/shared/types/openclaw-wire-core";

const INVALID_RESPONSE = "invalid-response" as const;

export interface ConnectTrace {
  url: string;
  stage: "ws-open" | "challenge" | "connect" | "done";
  success: boolean;
  wsOpenMs?: number;
  challengeMs?: number;
  connectMs?: number;
  totalMs: number;
  errorCode?: OpenclawWireErrorCode;
  errorMessage?: string;
}

export interface GatewayRpcClientOptions {
  url?: string;
  token?: string;
  deviceToken?: string;
  openclawConfigPath?: string;
  allowLegacyGatewayTokenFallback?: boolean;
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

hash?: string;
}

export interface SecretsReloadResult {
  warningCount?: number;
  ok?: boolean;
}

export interface GatewayRestartRequestResult {
  [extra: string]: unknown;
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
  configApply(config: object, baseHash: string): Promise<ConfigPatchResult>;
  configPatch(
    patch: object,
    baseHash: string,
    opts?: { replacePaths?: readonly string[] },
  ): Promise<ConfigPatchResult>;
  channelsStatus(): Promise<unknown>;
  secretsReload(): Promise<SecretsReloadResult>;
  gatewayRestartRequest(params: { reason: string; skipDeferral?: boolean }): Promise<GatewayRestartRequestResult>;
  cronAdd(spec: CronAddSpec): Promise<CronAddResult>;
  isGatewayUp(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

type GatewayRpcCall = (method: string, params: unknown) => Promise<unknown>;

async function writeConfig(
  call: GatewayRpcCall,
  method: "config.apply" | "config.patch",
  config: object,
  baseHash: string,
  replacePaths?: readonly string[],
): Promise<ConfigPatchResult> {
  try {
    const payload = await call(method, {
      raw: JSON.stringify(config),
      baseHash,
      ...(replacePaths && replacePaths.length > 0
        ? { replacePaths: [...replacePaths] }
        : {}),
    });
    if (!payload || typeof payload !== "object") {
      throw new OpenclawWireError(INVALID_RESPONSE, `${method} returned non-object payload`);
    }
    const result = payload as ConfigPatchResult;
    if (result.ok !== true) {
      throw new OpenclawWireError(INVALID_RESPONSE, `${method} payload missing \`ok: true\``);
    }
    return result;
  } catch (err) {
    if (err instanceof OpenclawWireError && err.code === "rpc-error") {
      const message = err.message.toLowerCase();
      if (message.includes("config changed since last load") || message.includes("base hash")) {
        throw new OpenclawWireError("hash-mismatch", err.message, err.details);
      }
      if (message.includes("invalid config")) {
        throw new OpenclawWireError("invalid-patch", err.message, err.details);
      }
    }
    throw err;
  }
}

export function createGatewayRpc(opts: GatewayRpcClientOptions = {}): GatewayRpcClient {
  const url =
    opts.url ??
    `ws://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || 18789}`;
  const auth = resolveGatewayAuth(opts);
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
      ...auth,
      connectTimeoutMs,
      identity: resolveIdentity(),
      scopes,
      onConnectTrace,
    });
    try {
      return await sendWsRequest({
        ws,
        id: randomUUID(),
        method,
        params,
        timeoutMs: callTimeoutMs,
      });
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
        throw new OpenclawWireError(INVALID_RESPONSE, "config.get returned non-object payload");
      }
      if (typeof snap.hash !== "string" || snap.hash.length === 0) {
        throw new OpenclawWireError(INVALID_RESPONSE, "config.get payload missing `hash`");
      }
      return { config: snap.config, hash: snap.hash };
    },

    async configApply(config, baseHash) {
      return await writeConfig(call, "config.apply", config, baseHash);
    },

    async configPatch(patch, baseHash, opts) {
      return await writeConfig(call, "config.patch", patch, baseHash, opts?.replacePaths);
    },

    async channelsStatus() {
      return await call("channels.status", {});
    },

    async gatewayRestartRequest(params) {
      const payload = await call("gateway.restart.request", params);
      if (!payload || typeof payload !== "object") {
        throw new OpenclawWireError(
          INVALID_RESPONSE,
          "gateway.restart.request returned non-object payload",
        );
      }
      return payload as GatewayRestartRequestResult;
    },

    async cronAdd(spec) {
      const payload = await call("cron.add", spec);
      if (!payload || typeof payload !== "object") {
        throw new OpenclawWireError(INVALID_RESPONSE, "cron.add returned non-object payload");
      }
      const p = payload as { id?: unknown };
      if (typeof p.id !== "string" || p.id.length === 0) {
        throw new OpenclawWireError(INVALID_RESPONSE, "cron.add payload missing string `id`");
      }
      return payload as CronAddResult;
    },

    async secretsReload() {
      const payload = await call("secrets.reload", {});
      if (!payload || typeof payload !== "object") {
        throw new OpenclawWireError(
          INVALID_RESPONSE,
          "secrets.reload returned non-object payload",
        );
      }
      const p = payload as { ok?: unknown; warningCount?: unknown };
      if (p.warningCount !== undefined && typeof p.warningCount !== "number") {
        throw new OpenclawWireError(
          INVALID_RESPONSE,
          `secrets.reload payload.warningCount must be a number when present (got ${typeof p.warningCount})`,
        );
      }
      if (p.ok !== undefined && typeof p.ok !== "boolean") {
        throw new OpenclawWireError(
          INVALID_RESPONSE,
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
          ...auth,
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

interface GatewayRpcAuth {
  token?: string;
  deviceToken?: string;
}

function resolveGatewayAuth(opts: GatewayRpcClientOptions): GatewayRpcAuth {
  if (typeof opts.deviceToken === "string" && opts.deviceToken.length > 0) {
    return { deviceToken: opts.deviceToken };
  }
  if (typeof opts.token === "string" && opts.token.length > 0) return { token: opts.token };
  if (!opts.allowLegacyGatewayTokenFallback) return {};
  const fromEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return { token: fromEnv };
  const fromFile = readTokenFromOpenClawJson(opts.openclawConfigPath);
  return fromFile ? { token: fromFile } : {};
}

function readTokenFromOpenClawJson(configPath?: string): string {
  const activeConfigPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  const resolved = configPath
    ?? activeConfigPath
    ?? path.join(os.homedir(), ".openclaw", "openclaw.json");
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

const PROTOCOL_VERSION = OPENCLAW_PROTOCOL_VERSION;

interface OpenAndConnectParams {
  url: string;
  token?: string;
  deviceToken?: string;
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

  const emitTrace = (success: boolean, err?: OpenclawWireError) => {
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
    await waitForWsOpen(ws, params.connectTimeoutMs);
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
      token: params.deviceToken || params.token || null,
      platform: clientInfo.platform,
    });
    let auth: { deviceToken: string } | { token: string } | undefined;
    if (params.deviceToken) auth = { deviceToken: params.deviceToken };
    else if (params.token) auth = { token: params.token };
    else auth = undefined;
    const connectStart = Date.now();
    await sendWsRequest({
      ws,
      id: randomUUID(),
      method: "connect",
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: clientInfo,
        role: "operator",
        scopes: params.scopes,
        device,
        ...(auth ? { auth } : {}),
      },
      timeoutMs: params.connectTimeoutMs,
      mapConnectErrors: true,
    });
    connectMs = Date.now() - connectStart;

    emitTrace(true);
  } catch (err) {
    try {
      ws.terminate();
    } catch { /* */ }
    emitTrace(false, err instanceof OpenclawWireError ? err : undefined);
    throw err;
  }

  return ws;
}
