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

export interface SecretsApplyRpcResult {
  mode?: string;
  changed?: boolean;
  changedFiles?: string[];
  warningCount?: number;
}

export interface GatewayRestartRequestResult {
  [extra: string]: unknown;
}

export interface GatewayChannelOperationParams {
  channel: string;
  accountId: string;
}

export interface GatewayChannelStopResult {
  channel: string;
  accountId: string;
  stopped: true;
  [extra: string]: unknown;
}

export interface GatewayChannelStartResult {
  channel: string;
  accountId: string;
  started: true;
  [extra: string]: unknown;
}

export interface GatewaySessionSummary {
  key: string;
  agentId?: string;
  hasActiveRun?: boolean;
}

export interface GatewaySessionsListResult {
  sessions: GatewaySessionSummary[];
  [extra: string]: unknown;
}

export interface GatewaySessionsResetResult {
  ok: true;
  [extra: string]: unknown;
}

export interface GatewayToolsCatalogResult {
  agentId: string;
  groups: unknown[];
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

export interface GatewayAgentsDeleteParams {
  agentId: string;
  deleteFiles?: boolean;
}

export interface GatewayAgentsDeleteResult {
  ok: true;
  agentId: string;
  removedBindings?: number;
  removed?: Array<{ path: string; method: "trash" | "missing" }>;
  failed?: unknown[];
  [extra: string]: unknown;
}

export interface GatewayAgentsCreateParams {
  name: string;
  workspace: string;
  model?: string;
  emoji?: string;
  avatar?: string;
}

export interface GatewayAgentsCreateResult {
  ok: true;
  agentId: string;
  name?: string;
  workspace?: string;
  [extra: string]: unknown;
}

const AGENT_NOT_FOUND_MESSAGE = /^agent "[^"]*" not found$/;
const AGENT_ALREADY_EXISTS_MESSAGE = /^agent "[^"]*" already exists$/;

/**
 * openclaw refuses `agents.create` for an id already in the roster with
 * `errorShape(INVALID_REQUEST, 'agent "<id>" already exists')`. An ensure that
 * raced another writer has to treat that as already-done; every other refusal —
 * an unwritable workspace, a wedged deletion journal, a transport failure —
 * must still fail the mount.
 */
export function isAgentAlreadyExistsRpcError(err: unknown): boolean {
  return (
    err instanceof OpenclawWireError &&
    err.code === "rpc-error" &&
    AGENT_ALREADY_EXISTS_MESSAGE.test(err.message)
  );
}

/**
 * openclaw refuses `agents.delete` for an id that is neither rostered nor
 * mid-deletion with `errorShape(INVALID_REQUEST, 'agent "<id>" not found')`
 * (server-methods/agents.ts respondAgentNotFound). An eviction has to treat
 * that as already-done; every other refusal — the default agent, a wedged
 * deletion journal, a transport failure — must still fail the eviction.
 */
export function isAgentNotFoundRpcError(err: unknown): boolean {
  return (
    err instanceof OpenclawWireError &&
    err.code === "rpc-error" &&
    AGENT_NOT_FOUND_MESSAGE.test(err.message)
  );
}

export interface GatewayRpcClient {
  configGet(): Promise<ConfigGetResult>;
  configApply(config: object, baseHash: string): Promise<ConfigPatchResult>;
  configPatch(
    patch: object,
    baseHash: string,
    opts?: { replacePaths?: readonly string[] },
  ): Promise<ConfigPatchResult>;
  configPatchAndWaitForChange(
    patch: object,
    baseHash: string,
    opts?: { replacePaths?: readonly string[] },
  ): Promise<ConfigPatchResult>;
  channelsStatus(): Promise<unknown>;
  channelsStop(params: GatewayChannelOperationParams): Promise<GatewayChannelStopResult>;
  channelsStart(params: GatewayChannelOperationParams): Promise<GatewayChannelStartResult>;
  secretsReload(): Promise<SecretsReloadResult>;
  secretsApply(params: { plan: object; dryRun?: boolean }): Promise<SecretsApplyRpcResult>;
  gatewayRestartRequest(params: { reason: string; skipDeferral?: boolean }): Promise<GatewayRestartRequestResult>;
  sessionsList(params: { agentId: string }): Promise<GatewaySessionsListResult>;
  sessionsReset(params: {
    key: string;
    agentId: string;
    reason: "new" | "reset";
  }): Promise<GatewaySessionsResetResult>;
  toolsCatalog(
    params: { agentId: string; includePlugins: true },
    timeoutMs?: number,
  ): Promise<GatewayToolsCatalogResult>;
  cronAdd(spec: CronAddSpec): Promise<CronAddResult>;
  agentsCreate(params: GatewayAgentsCreateParams): Promise<GatewayAgentsCreateResult>;
  agentsDelete(params: GatewayAgentsDeleteParams): Promise<GatewayAgentsDeleteResult>;
  isGatewayUp(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

type GatewayRpcCall = (method: string, params: unknown) => Promise<unknown>;

function configChangedHash(data: unknown): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof data === "string"
        ? data
        : (data as { toString: (encoding?: string) => string }).toString("utf-8"),
    );
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { type?: unknown }).type !== "event" ||
    (parsed as { event?: unknown }).event !== "config.changed"
  ) {
    return null;
  }
  const hash = (parsed as { payload?: { hash?: unknown } }).payload?.hash;
  return typeof hash === "string" && hash.length > 0 ? hash : null;
}

function trackConfigChange(ws: WebSocket): {
  waitFor: (hash: string, timeoutMs: number) => Promise<void>;
  close: () => void;
} {
  const changedHashes = new Set<string>();
  const waiters = new Map<string, Set<() => void>>();
  const onMessage = (data: unknown) => {
    const hash = configChangedHash(data);
    if (!hash) return;
    changedHashes.add(hash);
    for (const resolve of waiters.get(hash) ?? []) resolve();
    waiters.delete(hash);
  };
  ws.on("message", onMessage);
  return {
    waitFor(hash, timeoutMs) {
      if (changedHashes.has(hash)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(
            new OpenclawWireError(
              "timeout",
              `config.changed for persisted hash ${hash} timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        const onClose = () => {
          cleanup();
          reject(
            new OpenclawWireError(
              "connect-failed",
              `socket closed before config.changed published hash ${hash}`,
            ),
          );
        };
        const accepted = () => {
          cleanup();
          resolve();
        };
        function cleanup() {
          clearTimeout(timer);
          ws.removeListener("close", onClose);
          waiters.get(hash)?.delete(accepted);
        }
        const hashWaiters = waiters.get(hash) ?? new Set();
        hashWaiters.add(accepted);
        waiters.set(hash, hashWaiters);
        ws.on("close", onClose);
        if (changedHashes.has(hash)) accepted();
      });
    },
    close() {
      ws.removeListener("message", onMessage);
      waiters.clear();
    },
  };
}

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

function parseToolsCatalogResult(
  payload: unknown,
  agentId: string,
): GatewayToolsCatalogResult {
  if (!payload || typeof payload !== "object") {
    throw new OpenclawWireError(INVALID_RESPONSE, "tools.catalog returned non-object payload");
  }
  const result = payload as { agentId?: unknown; groups?: unknown };
  if (result.agentId !== agentId || !Array.isArray(result.groups)) {
    throw new OpenclawWireError(
      INVALID_RESPONSE,
      "tools.catalog payload missing the requested agentId or groups array",
    );
  }
  return payload as GatewayToolsCatalogResult;
}

async function fetchToolsCatalog(
  call: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>,
  params: { agentId: string; includePlugins: true },
  timeoutMs?: number,
): Promise<GatewayToolsCatalogResult> {
  return parseToolsCatalogResult(
    await call("tools.catalog", params, timeoutMs),
    params.agentId,
  );
}

function createDefaultConnectTraceHandler(
  traceVerbose: boolean,
  slowTraceMs: number,
  failureSampleMs: number,
): (trace: ConnectTrace) => void {
  let lastFailureKey = "";
  let lastFailureLogAt = 0;
  let suppressedFailures = 0;

  return (trace: ConnectTrace) => {
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
  };
}

interface ConfigPatchConnectionOptions {
  url: string;
  auth: GatewayRpcAuth;
  connectTimeoutMs: number;
  callTimeoutMs: number;
  identity: DeviceIdentity;
  scopes: string[];
  onConnectTrace: (trace: ConnectTrace) => void;
}

async function patchConfigAndWaitForChange(
  connection: ConfigPatchConnectionOptions,
  patch: object,
  baseHash: string,
  replacePaths?: readonly string[],
): Promise<ConfigPatchResult> {
  const ws = await openAndConnect({
    url: connection.url,
    ...connection.auth,
    connectTimeoutMs: connection.connectTimeoutMs,
    identity: connection.identity,
    scopes: connection.scopes,
    onConnectTrace: connection.onConnectTrace,
  });
  const change = trackConfigChange(ws);
  const connectedCall: GatewayRpcCall = async (method, params) =>
    await sendWsRequest({
      ws,
      id: randomUUID(),
      method,
      params,
      timeoutMs: connection.callTimeoutMs,
    });
  try {
    const result = await writeConfig(
      connectedCall,
      "config.patch",
      patch,
      baseHash,
      replacePaths,
    );
    if (result.noop === true) return result;
    if (!result.hash) {
      throw new OpenclawWireError(
        INVALID_RESPONSE,
        "config.patch payload missing `hash` required for config.changed correlation",
      );
    }
    await change.waitFor(result.hash, connection.callTimeoutMs);
    return result;
  } finally {
    change.close();
    try {
      ws.close();
    } catch { /* */ }
  }
}

interface ChannelsStatusConnectionOptions {
  url: string;
  auth: GatewayRpcAuth;
  connectTimeoutMs: number;
  callTimeoutMs: number;
  identity: () => DeviceIdentity;
  scopes: string[];
  onConnectTrace: (trace: ConnectTrace) => void;
}

function createChannelsStatusConnection(connection: ChannelsStatusConnectionOptions): {
  call: () => Promise<unknown>;
  close: () => Promise<void>;
} {
  let ws: WebSocket | null = null;
  let connecting: Promise<WebSocket> | null = null;
  let generation = 0;

  function disconnect(activeWs: WebSocket): void {
    if (ws === activeWs) ws = null;
    try {
      activeWs.close();
    } catch { /* */ }
  }

  async function getConnection(): Promise<WebSocket> {
    if (ws?.readyState === WebSocket.OPEN) return ws;
    if (connecting) return await connecting;

    const activeGeneration = generation;
    const pending = (async () => {
      const activeWs = await openAndConnect({
        url: connection.url,
        ...connection.auth,
        connectTimeoutMs: connection.connectTimeoutMs,
        identity: connection.identity(),
        scopes: connection.scopes,
        onConnectTrace: connection.onConnectTrace,
      });
      if (generation !== activeGeneration) {
        disconnect(activeWs);
        throw new OpenclawWireError(
          "connect-failed",
          "gateway RPC client closed while channels.status was connecting",
        );
      }
      ws = activeWs;
      activeWs.once("close", () => {
        if (ws === activeWs) ws = null;
      });
      return activeWs;
    })();
    connecting = pending;
    try {
      return await pending;
    } finally {
      if (connecting === pending) connecting = null;
    }
  }

  return {
    async call() {
      const activeWs = await getConnection();
      try {
        return await sendWsRequest({
          ws: activeWs,
          id: randomUUID(),
          method: "channels.status",
          params: {},
          timeoutMs: connection.callTimeoutMs,
        });
      } catch (err) {
        if (!(err instanceof OpenclawWireError) || err.code !== "rpc-error") {
          disconnect(activeWs);
        }
        throw err;
      }
    },
    async close() {
      generation++;
      const activeWs = ws;
      ws = null;
      if (activeWs) disconnect(activeWs);

      const pending = connecting;
      connecting = null;
      if (pending) {
        try {
          disconnect(await pending);
        } catch { /* */ }
      }
    },
  };
}

function createIdentityResolver(initialIdentity?: DeviceIdentity): () => DeviceIdentity {
  let identity = initialIdentity ?? null;
  return () => {
    if (identity) return identity;
    identity = loadOrCreateDeviceIdentity();
    return identity;
  };
}

function resolveRpcTraceSettings(): {
  traceVerbose: boolean;
  slowTraceMs: number;
  failureSampleMs: number;
} {
  return {
    traceVerbose: /^(1|true|yes|debug)$/i.test(process.env.OCTOGEE_RPC_TRACE_VERBOSE ?? ""),
    slowTraceMs: Number.parseInt(process.env.OCTOGEE_RPC_TRACE_SLOW_MS ?? "5000", 10),
    failureSampleMs: Number.parseInt(
      process.env.OCTOGEE_RPC_TRACE_FAILURE_SAMPLE_MS ?? "30000",
      10,
    ),
  };
}

type GatewayCall = (method: string, params: object) => Promise<unknown>;

async function callOkPayload(
  call: GatewayCall,
  method: string,
  params: object,
): Promise<Record<string, unknown>> {
  const payload = await call(method, params);
  if (!payload || typeof payload !== "object" || (payload as { ok?: unknown }).ok !== true) {
    throw new OpenclawWireError(INVALID_RESPONSE, `${method} payload missing \`ok: true\``);
  }
  return payload as Record<string, unknown>;
}

async function callAgentsCreate(
  call: GatewayCall,
  params: GatewayAgentsCreateParams,
): Promise<GatewayAgentsCreateResult> {
  const payload = await callOkPayload(call, "agents.create", params);
  if (typeof payload.agentId !== "string" || payload.agentId.length === 0) {
    throw new OpenclawWireError(
      INVALID_RESPONSE,
      "agents.create payload missing string `agentId`",
    );
  }
  return payload as GatewayAgentsCreateResult;
}

async function callAgentsDelete(
  call: GatewayCall,
  params: GatewayAgentsDeleteParams,
): Promise<GatewayAgentsDeleteResult> {
  return (await callOkPayload(call, "agents.delete", params)) as GatewayAgentsDeleteResult;
}

export function createGatewayRpc(opts: GatewayRpcClientOptions = {}): GatewayRpcClient {
  const url =
    opts.url ??
    `ws://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || process.env.GATEWAY_PORT || 18789}`;
  const auth = resolveGatewayAuth(opts);
  const connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
  const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  const scopes = opts.scopes ?? ["operator.admin"];
  const { traceVerbose, slowTraceMs, failureSampleMs } = resolveRpcTraceSettings();

  const onConnectTrace =
    opts.onConnectTrace ??
    createDefaultConnectTraceHandler(traceVerbose, slowTraceMs, failureSampleMs);

  const resolveIdentity = createIdentityResolver(opts.identity);

  async function call(
    method: string,
    params: unknown,
    requestTimeoutMs = callTimeoutMs,
  ): Promise<unknown> {
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
        timeoutMs: requestTimeoutMs,
      });
    } finally {
      try {
        ws.close();
      } catch { /* */ }
    }
  }

  const statusConnection = createChannelsStatusConnection({
    url, auth, connectTimeoutMs, callTimeoutMs, identity: resolveIdentity,
    scopes, onConnectTrace,
  });

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

    async configPatchAndWaitForChange(patch, baseHash, opts) {
      return await patchConfigAndWaitForChange(
        {
          url,
          auth,
          connectTimeoutMs,
          callTimeoutMs,
          identity: resolveIdentity(),
          scopes,
          onConnectTrace,
        },
        patch,
        baseHash,
        opts?.replacePaths,
      );
    },

    channelsStatus: statusConnection.call,

    async channelsStop(params) {
      const payload = await call("channels.stop", params);
      if (
        !payload ||
        typeof payload !== "object" ||
        (payload as { stopped?: unknown }).stopped !== true
      ) {
        throw new OpenclawWireError(
          INVALID_RESPONSE,
          "channels.stop payload missing `stopped: true`",
        );
      }
      return payload as GatewayChannelStopResult;
    },

    async channelsStart(params) {
      const payload = await call("channels.start", params);
      if (
        !payload ||
        typeof payload !== "object" ||
        (payload as { started?: unknown }).started !== true
      ) {
        throw new OpenclawWireError(
          INVALID_RESPONSE,
          "channels.start payload missing `started: true`",
        );
      }
      return payload as GatewayChannelStartResult;
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

    async sessionsList(params) {
      const payload = await call("sessions.list", params);
      if (!payload || typeof payload !== "object") {
        throw new OpenclawWireError(INVALID_RESPONSE, "sessions.list returned non-object payload");
      }
      const sessions = (payload as { sessions?: unknown }).sessions;
      if (!Array.isArray(sessions)) {
        throw new OpenclawWireError(INVALID_RESPONSE, "sessions.list payload missing `sessions` array");
      }
      for (const session of sessions) {
        if (!session || typeof session !== "object" || typeof (session as { key?: unknown }).key !== "string") {
          throw new OpenclawWireError(INVALID_RESPONSE, "sessions.list returned a session without string `key`");
        }
      }
      return payload as GatewaySessionsListResult;
    },

    async sessionsReset(params) {
      const payload = await call("sessions.reset", params);
      if (!payload || typeof payload !== "object" || (payload as { ok?: unknown }).ok !== true) {
        throw new OpenclawWireError(INVALID_RESPONSE, "sessions.reset payload missing `ok: true`");
      }
      return payload as GatewaySessionsResetResult;
    },

    toolsCatalog: (params, timeoutMs) => fetchToolsCatalog(call, params, timeoutMs),

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

    agentsCreate: (params) => callAgentsCreate(call, params),

    agentsDelete: (params) => callAgentsDelete(call, params),

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

    async secretsApply(params) {
      const payload = await call("secrets.apply", {
        plan: params.plan,
        allowExec: true,
        ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
      });
      if (!payload || typeof payload !== "object") {
        throw new OpenclawWireError(
          INVALID_RESPONSE,
          "secrets.apply returned non-object payload",
        );
      }
      const p = payload as { changed?: unknown };
      if (p.changed !== undefined && typeof p.changed !== "boolean") {
        throw new OpenclawWireError(
          INVALID_RESPONSE,
          `secrets.apply payload.changed must be a boolean when present (got ${typeof p.changed})`,
        );
      }
      return payload as SecretsApplyRpcResult;
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

    close: statusConnection.close,
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
