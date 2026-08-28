import http from "node:http";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { Registry, Counter, Gauge, Histogram } from "prom-client";
import { WsUpgradeRouter } from "@octogee/core/ws/upgrade-router";
import { publicAppOrigins } from "@octogee/core/deployment-environment";
import { OpenclawWireError } from "./openclaw/upstream.js";
import {
  clearGatewayDeviceToken,
  fetchGatewayAuth,
  invalidateGatewayToken,
  GatewayTokenError,
  type GatewayOpenClawAuth,
} from "./openclaw/gateway-token.js";
import { resolveBridgeGatewayId } from "./openclaw/bridge-gateway-id.js";
import { startBridgeUpstreamReconnectLoop } from "./openclaw/bridge-reconnect.js";
import {
  openAuthenticatedUpstream,
  openUpstreamWithGatewayAuth,
} from "./openclaw/authenticated-upstream.js";
import { shouldForwardFrame } from "./openclaw/frame-filter.js";
import {
  createGateState,
  evaluateInboundFrame,
  observeOutboundForState,
} from "./openclaw/inbound-gate.js";
import { isAllowedWsOrigin, warnIfWsOriginsMisconfigured } from "./openclaw/ws-origin.js";
import { applyGatewayPrefixStripInPlace, stripGatewayPrefix } from "./gateway-prefix.js";
import { createBridgeLog } from "./bridge-log.js";
import { isAllowedLocalhostOrigin } from "../lib/dev-origins.js";
import {
  guardUpgradeRequest,
  mmRosterVerdictFor,
  revisionUnavailableUpgradeResponse,
  type RollRosterUpgradeGate,
  type UpgradeGateVerdict,
} from "../roll-roster.js";
import { logger } from "../middleware/logging.js";
import {
  coachWiredInParsedConfig,
  listLocalCoachWiredSlugs,
  readOpenclawConfig,
} from "@octogee/core/local-coach-wired";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";

import { attachMmWsBridge, createMmWsRegistry } from "./mm-proxy/ws.js";
import {
  createBridgeBootStatus,
  bridgeHealthBody,
  type BridgeBootState,
} from "./openclaw/bridge-boot-status.js";
import {
  createOpenClawRuntimeBrokerFromEnv,
  OpenClawRuntimeBrokerError,
  type OpenClawRuntimeBroker,
} from "./openclaw/runtime-broker.js";
import { createProductionActivityIntakeHandler } from "./openclaw/activity-intake.js";
import { createActivityMmClientFactory } from "./openclaw/mm-client.js";
import {
  createReceiptBackedRetryMarker,
  verifyReceiptBackedRetryLineage,
} from "./openclaw/agent-control-retry-marker.js";
import { verifyHistoricalSubagentParent } from "./openclaw/subagent-lineage-authority.js";
import {
  createMattermostSigningKeySource,
  createMattermostTriggerVerifier,
} from "./openclaw/mattermost-trigger.js";
import type { ActivitySinkControlLifecycle } from "./openclaw/activity-sink.js";
import { ACTIVITY_INTAKE_PATH, SCHEDULED_ANCHOR_ADMISSION_PATH, VOICE_EVENT_RELAY_PATH } from "./http-paths.js";
import { createMattermostInteractionProxyHandler } from "./openclaw/mattermost-interaction-proxy.js";
import { createVoiceWsUpgradeHandler } from "../voice/route.js";
import type { AgentEventSource } from "../voice/brain.js";
import { SileroVad } from "../voice/silero-vad.js";
import { createOpenClawVoiceEventRelay } from "../voice/openclaw-event-relay.js";
import {
  createScheduledAnchorAdmission,
  verifyScheduledAnchorBinding,
} from "./openclaw/scheduled-anchor.js";
import { createScheduledAnchorAdmissionHandler } from "./openclaw/scheduled-anchor-route.js";
import {
  CandidateActivityRuntimeRegistry,
  readMattermostChannelCreateAt,
  replaceCandidateRuntimeSnapshot,
  resolveCandidateActivityBinding,
} from "./openclaw/candidate-activity-runtime.js";
import {
  createActivityCoachTracker,
  type ActivityCoachTracker,
  wireActivityCoachEventListeners,
} from "./openclaw/activity-coach-tracker.js";
export { chatProxyOwnsHttpPath } from "./http-paths.js";

if (process.env.NODE_ENV !== "test") {
  if (!process.env.MM_INTERNAL_URL) {
    console.error("FATAL: MM_INTERNAL_URL is required (in-cluster Mattermost URL, e.g. http://mattermost.<ns>.svc.cluster.local:8065)");
    process.exit(1);
  }
}
const MM_INTERNAL_URL = process.env.MM_INTERNAL_URL || "https://mm-test.invalid";
const DEFAULT_OPENCLAW_GATEWAY_URL = "http://127.0.0.1:18789";
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT || "octogee";
const SA_KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.SA_KEY_PATH;
const COACH_RECONCILE_CUSTOMERS_DIR = process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers";
const COACH_RECONCILE_OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || "/home/node/.openclaw/openclaw.json";
const COACH_RECONCILE_INTERVAL_MS = 60_000;

const bridgeLog = createBridgeLog();

const MM_PUBLIC_URL = MM_INTERNAL_URL;
const BRIDGE_UNSYNCHRONIZED = 'unsynchronized' as const;
const AUTH_FAILED = 'auth-failed' as const;

interface BridgeBootStatusSetter {
  set(status: BridgeBootState): void;
}

const MM_INTERNAL_WS_URL = MM_INTERNAL_URL.replace(/^http/, "ws") + "/api/v4/websocket";

const mmWsRegistry = createMmWsRegistry();

const mmUserIdCache = new Map<string, { userId: string; cachedAt: number }>();
const MM_USER_ID_CACHE_TTL_MS = 5 * 60 * 1000;
const MM_USER_ID_CACHE_MAX_ENTRIES = 1_000;

async function resolveMmUserId(mmToken: string): Promise<string | null> {
  const cached = mmUserIdCache.get(mmToken);
  const nowMs = Date.now();
  if (cached && nowMs - cached.cachedAt < MM_USER_ID_CACHE_TTL_MS) {
    mmUserIdCache.delete(mmToken);
    mmUserIdCache.set(mmToken, cached);
    return cached.userId;
  }
  if (cached) {
    mmUserIdCache.delete(mmToken);
  }
  try {
    const resp = await fetch(`${MM_INTERNAL_URL}/api/v4/users/me`, {
      headers: { Authorization: `Bearer ${mmToken}` },
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { id?: unknown };
    if (typeof body.id !== "string" || body.id.length === 0) return null;
    mmUserIdCache.set(mmToken, { userId: body.id, cachedAt: nowMs });
    evictMmUserIdCacheIfNeeded();
    return body.id;
  } catch (err) {
    console.warn(`[mm-proxy] resolveMmUserId failed: ${(err as Error).message}`);
    return null;
  }
}

function parseRetryAfterMs(raw: string | null): number | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }
  const asDateMs = Date.parse(trimmed);
  if (Number.isFinite(asDateMs)) {
    const delta = asDateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

function evictMmUserIdCacheIfNeeded(): void {
  const nowMs = Date.now();
  for (const [token, entry] of mmUserIdCache) {
    if (nowMs - entry.cachedAt >= MM_USER_ID_CACHE_TTL_MS) {
      mmUserIdCache.delete(token);
    }
  }
  while (mmUserIdCache.size > MM_USER_ID_CACHE_MAX_ENTRIES) {
    const oldestKey = mmUserIdCache.keys().next().value;
    if (oldestKey === undefined) break;
    mmUserIdCache.delete(oldestKey);
  }
}

async function probeGatewayReady(
  healthUrl: string,
): Promise<{ ready: boolean; retryAfterMs?: number }> {
  try {
    const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
    if (resp.ok) return { ready: true };
    return { ready: false, retryAfterMs: parseRetryAfterMs(resp.headers.get("retry-after")) };
  } catch {
    return { ready: false };
  }
}

export const chatProxyMetricsRegistry = new Registry();
const metricsRegistry = chatProxyMetricsRegistry;

const ocWsConnectionsActive = new Gauge({
  name: 'chat_proxy_openclaw_ws_connections_active',
  help: 'Active OpenClaw gateway proxy connections',
  registers: [metricsRegistry],
});

const activityMissingFinalTotal = new Counter({
  name: "octogee_activity_missing_final_total",
  help: "Agent runs that reached a terminal state without a durable primary-channel final",
  registers: [metricsRegistry],
});

const activityRoutineNormalDeliveryTotal = new Counter({
  name: "octogee_activity_routine_normal_delivery_total",
  help: "Routine Activity posts observed without silent delivery",
  registers: [metricsRegistry],
});

const activityOrphanTotal = new Counter({
  name: "octogee_activity_orphan_total",
  help: "Activity items whose committed run root could not be resolved",
  registers: [metricsRegistry],
});

const activityAttachmentUnknownTotal = new Counter({
  name: "octogee_activity_attachment_unknown_total",
  help: "Mattermost uploads whose final response could not be mapped to a durable file id",
  registers: [metricsRegistry],
});

export const activityRuntimeRegistry = new CandidateActivityRuntimeRegistry();

export function recordActivityMissingFinal(): void {
  activityMissingFinalTotal.inc();
}

export function recordRoutineActivityNormalDelivery(): void {
  activityRoutineNormalDeliveryTotal.inc();
}

export function recordActivityOrphan(): void {
  activityOrphanTotal.inc();
}

const ocWsHandshakeTotal = new Counter({
  name: 'chat_proxy_openclaw_ws_handshakes_total',
  help: 'Total OpenClaw upstream handshake outcomes',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

const ocWsRotationRecoveredTotal = new Counter({
  name: 'chat_proxy_openclaw_ws_rotation_recovered_total',
  help: 'OpenClaw upstream handshakes that succeeded after an auth-failed rotation retry',
  registers: [metricsRegistry],
});

const ocWsFrameFilterTotal = new Counter({
  name: 'chat_proxy_openclaw_ws_frame_filter_total',
  help: 'Per-user frame-filter decisions on inbound gateway events',
  labelNames: ['decision', 'reason'] as const,
  registers: [metricsRegistry],
});

const ocWsInboundGateTotal = new Counter({
  name: 'chat_proxy_openclaw_ws_inbound_gate_total',
  help: 'Browser-to-gateway frame allowlist decisions',
  labelNames: ['decision', 'reason'] as const,
  registers: [metricsRegistry],
});

const activityIntakeTotal = new Counter({
  name: 'octogee_activity_intake_total',
  help: 'Durable Activity intake outcomes',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

const activityReactionDispatchMs = new Histogram({
  name: 'octogee_activity_reaction_dispatch_ms',
  help: 'Mattermost reaction to OpenClaw control dispatch latency',
  labelNames: ['emoji', 'outcome'] as const,
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [metricsRegistry],
});

const bridgeBootStatusGauge = new Gauge({
  name: 'octogee_activity_projection_boot_status',
  help: 'Activity projection boot state — one label is 1, the rest 0',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

const bridgeBootStatus = createBridgeBootStatus({
  gauge: bridgeBootStatusGauge,
  log: bridgeLog,
});

export async function openBackgroundBridgeUpstream(
  gatewayId: string,
  url: string,
  bootStatus: BridgeBootStatusSetter = bridgeBootStatus,
): Promise<WebSocket> {
  try {
    return await openAuthenticatedUpstream({ gatewayId, url });
  } catch (error) {
    const code = error instanceof OpenclawWireError ? error.code : undefined;
    bootStatus.set(code === AUTH_FAILED ? AUTH_FAILED : 'unreachable');
    throw error;
  }
}

let mattermostInteractionProxyHandler:
  | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)
  | null = null;
let agentControlCallbackHandler:
  | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)
  | null = null;

export function installAgentControlCallbackHandler(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
): void {
  agentControlCallbackHandler = handler;
}

let activityIntakeHandler:
  | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)
  | null = null;

export function installActivityIntakeHandler(
  handler: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | null,
): void {
  activityIntakeHandler = handler;
}

let scheduledAnchorAdmissionHandler:
  | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)
  | null = null;

export function installScheduledAnchorAdmissionHandler(
  handler: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | null,
): void {
  scheduledAnchorAdmissionHandler = handler;
}

const voiceEventRelayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
const voiceEventRelay = voiceEventRelayToken
  ? createOpenClawVoiceEventRelay({
      gatewayToken: voiceEventRelayToken,
      log: (message, fields) => logger.warn(`[voice] ${message}`, fields),
    })
  : null;
const unavailableVoiceEventSource: AgentEventSource = {
  subscribe: () => () => undefined,
};

const FRAME_DROP_LOG_WINDOW_MS = 60_000;
// Retry-After hint for a WS upgrade refused because the serving revision is not
// resolvable yet (mirrors the roll-roster gate's default). The client reconnects
// after the roll settles rather than seeing an opaque failure.
const WS_REVISION_UNAVAILABLE_RETRY_SECONDS = 2;
const lastFrameDropLogByUid = new Map<string, number>();
const filteredFrameCountByUid = new Map<string, Map<string, number>>();

function bumpFilteredFrameCount(uid: string, reason: string): void {
  let perReason = filteredFrameCountByUid.get(uid);
  if (!perReason) {
    perReason = new Map<string, number>();
    filteredFrameCountByUid.set(uid, perReason);
  }
  perReason.set(reason, (perReason.get(reason) ?? 0) + 1);
}

function drainFilteredFrameCounts(uid: string): string {
  const perReason = filteredFrameCountByUid.get(uid);
  if (!perReason || perReason.size === 0) return "";
  const parts: string[] = [];
  for (const [reason, count] of perReason) {
    parts.push(`${reason}=${count}`);
  }
  filteredFrameCountByUid.delete(uid);
  return parts.join(",");
}
const lastInboundDropLogByUid = new Map<string, number>();

function normalizeWsData(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
}

let openclawRuntimeBroker: OpenClawRuntimeBroker | undefined;
function getOpenClawRuntimeBroker(): OpenClawRuntimeBroker {
  if (openclawRuntimeBroker === undefined) {
    openclawRuntimeBroker = createOpenClawRuntimeBrokerFromEnv();
  }
  return openclawRuntimeBroker;
}

function watchBrokerGatewayIdChange(
  broker: OpenClawRuntimeBroker,
  uid: string,
  initialGatewayId: string,
  onChange: (newGatewayId: string | null) => void,
  intervalMs: number = 30_000,
): () => void {
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    broker.getUserGatewayId(uid)
      .then((newGatewayId) => {
        if (!newGatewayId || newGatewayId === initialGatewayId || fired) return;
        fired = true;
        onChange(newGatewayId);
      })
      .catch((err) => {
        if (err instanceof OpenClawRuntimeBrokerError && err.status === 403 && !fired) {
          fired = true;
          onChange(null);
          return;
        }
        console.warn(
          `[proxy] OC WS: broker gatewayId watch failed for uid=${uid}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

if (!getApps().length) {
  if (SA_KEY_PATH) {
    const fs = await import("node:fs");
    const sa = JSON.parse(fs.readFileSync(SA_KEY_PATH, "utf-8"));
    initializeApp({ credential: cert(sa), projectId: FIREBASE_PROJECT });
    console.log(`[chat-proxy] Using SA key: ${SA_KEY_PATH}`);
  } else {
    initializeApp({ projectId: FIREBASE_PROJECT });
    console.log(`[chat-proxy] Using ADC for project: ${FIREBASE_PROJECT}`);
  }
}
const db = getFirestore();

function proxyAuthToken(req: http.IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ") || authHeader?.startsWith("BEARER ")) {
    return authHeader.slice(7);
  }
  return authHeader?.startsWith("Token ") ? authHeader.slice(6) : null;
}

function authFailureMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function verifyAuth(req: http.IncomingMessage): Promise<string | null> {
  const token = proxyAuthToken(req);
  if (!token) return null;

  try {
    const decoded = await getAuth().verifyIdToken(token, true);
    const userSnap = await db.collection("users").doc(decoded.uid).get();
    const userData = userSnap.exists ? userSnap.data() : undefined;
    return userData && accountAllowsInteractiveAccess(userData)
      ? decoded.uid
      : null;
  } catch (error) {
    console.error(`[proxy] auth failed: ${authFailureMessage(error)}`);
    return null;
  }
}

const ALLOWED_ORIGINS = new Set(publicAppOrigins());

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.has(origin) || isAllowedLocalhostOrigin(origin);
}

export function setCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin as string | undefined;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function handleLocalInternalRoute(
  path: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (path === ACTIVITY_INTAKE_PATH) {
    if (!activityIntakeHandler) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "runtime_unsynchronized", retryable: true }));
    } else {
      await activityIntakeHandler(req, res);
    }
    return true;
  }
  if (path === SCHEDULED_ANCHOR_ADMISSION_PATH) {
    if (!scheduledAnchorAdmissionHandler) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "admission_unavailable" }));
    } else {
      await scheduledAnchorAdmissionHandler(req, res);
    }
    return true;
  }
  if (path !== VOICE_EVENT_RELAY_PATH) return false;
  if (!voiceEventRelay) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "voice_relay_unconfigured" }));
  } else {
    await voiceEventRelay.handle(req, res);
  }
  return true;
}

function handleHealthRoute(path: string, res: http.ServerResponse): boolean {
  if (path === "/healthz" || path === "/health" || path === "/_health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return true;
  }
  if (path !== "/healthz/bridge") return false;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(bridgeHealthBody(bridgeBootStatus.snapshot(), Date.now())));
  return true;
}

async function handleControlRoute(
  path: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (/^\/internal\/openclaw\/mattermost\/interactions\/[A-Za-z0-9_-]{1,128}$/.test(path)) {
    if (!mattermostInteractionProxyHandler) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "service_unavailable", reason: "interaction proxy not initialized" }));
    } else {
      await mattermostInteractionProxyHandler(req, res);
    }
    return true;
  }
  if (path !== "/internal/openclaw/agent-control/callback") return false;
  if (!agentControlCallbackHandler) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "service_unavailable", reason: "agent control handler not initialized" }));
  } else {
    await agentControlCallbackHandler(req, res);
  }
  return true;
}

export async function chatProxyHandleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const originalPath = (req.url || "").split("?")[0];
  if (await handleLocalInternalRoute(originalPath, req, res)) return;

  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = applyGatewayPrefixStripInPlace(req);
  if (handleHealthRoute(urlPath, res)) return;
  if (await handleControlRoute(urlPath, req, res)) return;

  req.resume();
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

type UpstreamOutcome =
  | { ok: true; upstream: WebSocket }
  | { ok: false; httpStatus: string };

type GatewayAuthOutcome =
  | { ok: true; auth: GatewayOpenClawAuth }
  | { ok: false; httpStatus: string };

type OpenAttempt =
  | { ok: true; upstream: WebSocket }
  | { ok: false; code: string };

export async function establishUpstreamWithRotation(
  gatewayId: string,
  gatewayUrl: string,
): Promise<UpstreamOutcome> {
  const auth = await fetchInitialGatewayAuth(gatewayId);
  if (!auth.ok) return auth;

  const first = await tryOpenGatewayUpstream(gatewayId, gatewayUrl, auth.auth);
  if (first.ok) return acceptUpstreamHandshake(first.upstream);
  if (first.code !== AUTH_FAILED) return rejectUpstreamHandshake(first.code);

  await clearStaleGatewayAuth(gatewayId, auth.auth);
  const fresh = await fetchGatewayAuthAfterRotation(gatewayId);
  if (!fresh.ok) return fresh;

  const retry = await tryOpenGatewayUpstream(gatewayId, gatewayUrl, fresh.auth);
  if (retry.ok) return acceptRotationRecovery(retry.upstream);
  return rejectRotationHandshake(retry.code);
}

async function fetchInitialGatewayAuth(gatewayId: string): Promise<GatewayAuthOutcome> {
  try {
    const auth = await fetchGatewayAuth({ gatewayId, allowLegacyFallback: true });
    return { ok: true, auth };
  } catch (e) {
    if (!(e instanceof GatewayTokenError)) throw e;
    console.error(`[proxy] OC WS: gateway auth fetch failed — ${e.code}: ${e.message}`);
    return { ok: false, httpStatus: "503 Service Unavailable" };
  }
}

async function fetchGatewayAuthAfterRotation(gatewayId: string): Promise<GatewayAuthOutcome> {
  try {
    const auth = await fetchGatewayAuth({ gatewayId, skipCache: true, allowLegacyFallback: true });
    return { ok: true, auth };
  } catch (fetchErr) {
    const fetchCode = fetchErr instanceof GatewayTokenError ? fetchErr.code : "unknown";
    console.error(`[proxy] OC WS: gateway auth re-fetch during rotation failed — ${fetchCode}`);
    ocWsHandshakeTotal.inc({ outcome: `fail:refetch:${fetchCode}` });
    return { ok: false, httpStatus: "503 Service Unavailable" };
  }
}

async function tryOpenGatewayUpstream(
  gatewayId: string,
  gatewayUrl: string,
  auth: GatewayOpenClawAuth,
): Promise<OpenAttempt> {
  try {
    const upstream = await openUpstreamWithGatewayAuth({
      gatewayId,
      url: gatewayUrl,
      pairingUrl: process.env.OPENCLAW_GATEWAY_URL ?? DEFAULT_OPENCLAW_GATEWAY_URL,
    }, auth);
    return { ok: true, upstream };
  } catch (e) {
    const code = e instanceof OpenclawWireError ? e.code : "unknown";
    return { ok: false, code };
  }
}

async function clearStaleGatewayAuth(gatewayId: string, auth: GatewayOpenClawAuth): Promise<void> {
  if (auth.source === "legacy-token") {
    invalidateGatewayToken(gatewayId);
    return;
  }
  await clearGatewayDeviceToken();
}

function acceptUpstreamHandshake(upstream: WebSocket): UpstreamOutcome {
  ocWsHandshakeTotal.inc({ outcome: "ok" });
  return { ok: true, upstream };
}

function acceptRotationRecovery(upstream: WebSocket): UpstreamOutcome {
  ocWsHandshakeTotal.inc({ outcome: "ok" });
  ocWsRotationRecoveredTotal.inc();
  return { ok: true, upstream };
}

function rejectUpstreamHandshake(code: string): UpstreamOutcome {
  console.log(`[proxy] OC WS: upstream handshake failed — ${code}`);
  ocWsHandshakeTotal.inc({ outcome: `fail:${code}` });
  return { ok: false, httpStatus: "502 Bad Gateway" };
}

function rejectRotationHandshake(code: string): UpstreamOutcome {
  console.log(`[proxy] OC WS: upstream handshake failed after rotation retry — ${code}`);
  ocWsHandshakeTotal.inc({ outcome: `fail:${code}` });
  return { ok: false, httpStatus: "502 Bad Gateway" };
}

function handleOpenClawWsUpgrade(
  wss: WebSocketServer,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: {
    upgradeGate: RollRosterUpgradeGate | null;
    runtimeBroker?: OpenClawRuntimeBroker;
    gatewayWatchIntervalMs?: number;
  },
): void {
  const { upgradeGate, runtimeBroker: runtimeBrokerOverride, gatewayWatchIntervalMs } = options;
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!isAllowedWsOrigin(origin)) {
    ocWsHandshakeTotal.inc({ outcome: "fail:origin-rejected" });
    console.warn(`[proxy] OC WS: rejected origin=${origin ?? "(none)"}`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  const urlPath = stripGatewayPrefix((req.url || "").split("?")[0]);
  const pathMatch = urlPath.match(/\/api\/openclaw\/ws\/([a-f0-9-]{36})$/);
  const ticket = pathMatch?.[1] || null;

  if (!ticket) {
    console.log(`[proxy] OC WS: no ticket`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  (async () => {
    try {
      const runtimeBroker = runtimeBrokerOverride ?? getOpenClawRuntimeBroker();
      const redeemOutcome = await runtimeBroker.redeemOpenClawWs(ticket);
      if (redeemOutcome.kind === "unauthorized") {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      if (redeemOutcome.kind === "revision-unavailable") {
        // The broker could not resolve a LIVE serving revision (mid-roll or a
        // just-retired revision). Surface the SAME retryable roll-in-progress
        // signal as a roster refusal — never a generic 500 — so the client
        // reconnects once the roll settles instead of hard-failing.
        console.warn(
          `[proxy] OC WS: revision unavailable (${redeemOutcome.reason}) — refusing with retryable 503`,
        );
        socket.write(
          revisionUnavailableUpgradeResponse(
            WS_REVISION_UNAVAILABLE_RETRY_SECONDS,
            redeemOutcome.reason,
          ),
        );
        socket.destroy();
        return;
      }
      const redeemed = redeemOutcome.redeemed;
      const uid = redeemed.uid;
      const gatewayUrl = redeemed.gatewayUrl;
      const gatewayId = redeemed.gatewayId;
      const expectedAgentId = redeemed.expectedAgentId;

      // Post-auth roster verdict (the ticket just resolved the customer): a
      // quiescing customer or one serving on another revision must never
      // attach here — refuse so the client reconnects via the serving
      // revision.
      if (upgradeGate) {
        const verdict = upgradeGate.checkUid(uid);
        if (!verdict.allow) {
          upgradeGate.refuse(socket, verdict);
          return;
        }
      }

      const outcome = await establishUpstreamWithRotation(gatewayId, gatewayUrl);
      if (!outcome.ok) {
        socket.write(`HTTP/1.1 ${outcome.httpStatus}\r\n\r\n`);
        socket.destroy();
        return;
      }
      const upstream = outcome.upstream;

      const gateState = createGateState(expectedAgentId);

      wss.handleUpgrade(req, socket, head, (clientWs) => {
        ocWsConnectionsActive.inc();

        const stopGatewayWatch = watchBrokerGatewayIdChange(
          runtimeBroker,
          uid,
          gatewayId,
          (newGatewayId) => {
            const destination = newGatewayId ?? "not-assigned-here";
            console.log(
              `[proxy] OC WS: gatewayId changed for uid=${uid}: ${gatewayId} → ${destination}; forcing reconnect`,
            );
            try {
              clientWs.close(1001, "gatewayId-changed");
            } catch {
              // best-effort
            }
          },
          gatewayWatchIntervalMs,
        );

        clientWs.on("message", (data, isBinary) => {
          if (upstream.readyState !== WebSocket.OPEN) return;
          const buf = normalizeWsData(data);
          const decision = evaluateInboundFrame(buf, isBinary, gateState);
          ocWsInboundGateTotal.inc({
            decision: decision.accept ? "accept" : "drop",
            reason: decision.reason,
          });
          if (!decision.accept) {
            const now = Date.now();
            const last = lastInboundDropLogByUid.get(uid) ?? 0;
            if (now - last >= FRAME_DROP_LOG_WINDOW_MS) {
              lastInboundDropLogByUid.set(uid, now);
              console.warn(
                `[proxy] OC WS: dropped inbound frame uid=${uid} reason=${decision.reason}`,
              );
            }
            return;
          }
          upstream.send(isBinary ? buf : buf.toString("utf8"), { binary: isBinary });
        });
        upstream.on("message", (data, isBinary) => {
          if (clientWs.readyState !== WebSocket.OPEN) return;
          if (isBinary) {
            clientWs.send(data, { binary: true });
            return;
          }
          const text = data.toString();
          const decision = shouldForwardFrame(text, { expectedAgentId });
          ocWsFrameFilterTotal.inc({
            decision: decision.forward ? "forward" : "drop",
            reason: decision.reason,
          });
          if (decision.forward) {
            observeOutboundForState(text, gateState);
            clientWs.send(text);
          } else {
            bumpFilteredFrameCount(uid, decision.reason);
            const now = Date.now();
            const last = lastFrameDropLogByUid.get(uid);
            if (last === undefined) {
              lastFrameDropLogByUid.set(uid, now);
            } else if (now - last >= FRAME_DROP_LOG_WINDOW_MS) {
              lastFrameDropLogByUid.set(uid, now);
              const counts = drainFilteredFrameCounts(uid);
              console.info(
                `[proxy] OC WS fan-out filtered frames uid=${uid} window=${FRAME_DROP_LOG_WINDOW_MS}ms counts=${counts} (correct per-user routing, not lost messages)`,
              );
            }
          }
        });
        clientWs.on("close", () => {
          ocWsConnectionsActive.dec();
          stopGatewayWatch();
          try {
            upstream.close();
          } catch {}
        });
        upstream.on("close", () => clientWs.close());
        clientWs.on("error", () => {
          try {
            upstream.close();
          } catch {}
        });
        upstream.on("error", () => clientWs.close());
      });
    } catch (e) {
      console.error(`[proxy] OC WS error: ${e instanceof Error ? e.message : String(e)}`);
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    }
  })();
}

export function _clearCaches(): void {
  mmUserIdCache.clear();
  firebaseUidByMmUserId.clear();
  openclawRuntimeBroker = undefined;
}

export function gatewayHealthUrl(
  base: string = process.env.OPENCLAW_GATEWAY_URL ?? DEFAULT_OPENCLAW_GATEWAY_URL,
): string {
  return `${base}/healthz`;
}

export interface AttachChatProxyWsUpgradeOptions {
  // Roll-roster gate for revision pods (Codex P0): upgrades bypass Express, so
  // the SAME roster/boot checks the HTTP middleware runs must run here, at the
  // one shared upgrade handler — BEFORE any dispatch, so every current and
  // future upgrade route is covered by construction.
  upgradeGate?: RollRosterUpgradeGate | null;
  runtimeBroker?: OpenClawRuntimeBroker;
  gatewayWatchIntervalMs?: number;
}

// mmUserId → Firebase uid for the roll-roster verdict. The mapping is written
// once at provisioning (users/{uid}.mattermost.userId), so positive lookups
// cache forever; misses are re-queried per auth. A lookup that resolves to
// nothing (missing/stale mapping) is REFUSED — never served locally during a
// roll; a lookup that throws fails CLOSED (the client reconnects, retry
// semantics), it never attaches ungated.
const firebaseUidByMmUserId = new Map<string, string>();

export function buildMmRosterVerdict(
  gate: RollRosterUpgradeGate,
  lookupUid: (mmUserId: string) => Promise<string | null>,
): (mmUserId: string | null) => Promise<UpgradeGateVerdict> {
  return (mmUserId) =>
    mmRosterVerdictFor(gate, mmUserId, async (id) => {
      const cached = firebaseUidByMmUserId.get(id);
      if (cached !== undefined) return cached;
      const uid = await lookupUid(id);
      if (uid !== null) firebaseUidByMmUserId.set(id, uid);
      return uid;
    });
}

export function attachChatProxyWsUpgrade(
  server: http.Server,
  opts: AttachChatProxyWsUpgradeOptions = {},
) {
  const wss = new WebSocketServer({ noServer: true });
  const mmWss = new WebSocketServer({ noServer: true });

  const wsRouter = new WsUpgradeRouter();
  const upgradeGate = opts.upgradeGate ?? null;
  const voiceWsUpgrade = createVoiceWsUpgradeHandler({
    runtimeBroker: {
      redeemOpenClawWs: (ticket, purpose) =>
        (opts.runtimeBroker ?? getOpenClawRuntimeBroker()).redeemOpenClawWs(ticket, purpose),
    },
    eventSourceForAgent: (agentId) => voiceEventRelay?.source(agentId) ?? unavailableVoiceEventSource,
    isAgentReady: (agentId) => voiceEventRelay?.readiness(agentId).ready ?? false,
    upgradeGate,
    isAllowedWsOrigin,
    stripGatewayPrefix,
    relayBaseUrl: process.env.OPENCLAW_RUNTIME_BROKER_URL ?? "",
    mmInternalUrl: MM_INTERNAL_URL,
    createVad: () => SileroVad.create(),
    registry: chatProxyMetricsRegistry,
    log: (message, fields) => console.log(`[voice] ${message}`, fields ?? {}),
  });

  server.on("upgrade", (req, socket, head) => {
    if (guardUpgradeRequest(upgradeGate, req, socket)) return;
    const originalUrl = req.url ?? "(none)";

    const urlPath = applyGatewayPrefixStripInPlace(req);
    if (urlPath.startsWith("/api/voice/ws/")) {
      void voiceWsUpgrade(req, socket, head);
      return;
    }
    if (urlPath.startsWith("/api/openclaw/ws/")) {
      handleOpenClawWsUpgrade(
        wss,
        req,
        socket,
        head,
        {
          upgradeGate,
          runtimeBroker: opts.runtimeBroker,
          gatewayWatchIntervalMs: opts.gatewayWatchIntervalMs,
        },
      );
      return;
    }
    if (urlPath === "/api/v4/websocket") {
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      if (!isAllowedWsOrigin(origin)) {
        console.warn(`[mm-proxy/ws] rejected origin=${origin ?? "(none)"}`);
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      console.warn(`[mm-proxy/ws] upgrade accepted origin=${origin ?? "(none)"}`);
      mmWss.handleUpgrade(req, socket, head, (browserWs) => {
        attachMmWsBridge(
          {
            mmInternalWsUrl: MM_INTERNAL_WS_URL,
            log: bridgeLog,
            resolveMmUserId,
            openUpstream: (url) => new WebSocket(url),
            registry: mmWsRegistry,
            // Auth-late roster enforcement (Codex P0): MM identity resolves
            // from the first auth frame, so the bridge holds the upstream dial
            // until this verdict — the shared upgrade-gate policy — admits. The
            // mmUser→uid step routes through the tenant-bound runtime broker,
            // like every other resolution on this creds-less pod — a direct
            // Firestore read has no credentials here and would hang admission
            // forever (the client-reconnect-loop regression from #2161).
            ...(upgradeGate
              ? {
                  rosterVerdict: buildMmRosterVerdict(upgradeGate, (mmUserId) =>
                    getOpenClawRuntimeBroker().resolveOctogeeUidByMmUser(mmUserId),
                  ),
                }
              : {}),
          },
          browserWs,
        );
      });
      return;
    }
    if (wsRouter.dispatch(req, socket, head)) return;

    const redactWsPath = (p: string) => p.replace(/[A-Za-z0-9_-]{16,}/g, "<redacted>");
    console.warn(
      `[ws-upgrade] no route matched — 404 strippedPath=${redactWsPath(urlPath)} originalUrl=${redactWsPath(originalUrl)}`,
    );
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });

  (server as unknown as { wsRouter: WsUpgradeRouter }).wsRouter = wsRouter;
}

async function readMountedCoachCustomers(): Promise<readonly string[] | null> {
  if (!fs.existsSync(COACH_RECONCILE_CUSTOMERS_DIR)) return null;
  const config = readOpenclawConfig(COACH_RECONCILE_OPENCLAW_CONFIG);
  if (!config) return null;
  return listLocalCoachWiredSlugs(
    COACH_RECONCILE_CUSTOMERS_DIR,
    (slug) => coachWiredInParsedConfig(config, slug),
  );
}

function startActivityCoachMountReconciliation(tracker: ActivityCoachTracker): void {
  const timer = setInterval(() => {
    void tracker.reconcileMountedCustomers();
  }, COACH_RECONCILE_INTERVAL_MS);
  timer.unref();
}

function installProductionActivityIntake(
  controls: ActivitySinkControlLifecycle,
  runtimeBroker: OpenClawRuntimeBroker,
  tracker: ActivityCoachTracker,
): void {
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!gatewayToken) throw new Error("activity intake gateway token is required");
  const mmClientFor = createActivityMmClientFactory({ baseUrl: MM_INTERNAL_URL });
  installActivityIntakeHandler(createProductionActivityIntakeHandler({
    gatewayToken,
    registry: activityRuntimeRegistry,
    receiptsFor: (binding) => runtimeBroker.activityWriteReceiptsFor(binding.channelDocPath),
    mmClientFor,
    leaseOwner: `${process.env.HOSTNAME ?? "gateway-edge"}:${process.pid}`,
    requestBuilderActivation: (input) =>
      runtimeBroker.requestBuilderRunActivation(input),
    alerts: {
      attachmentUnknown: () => activityAttachmentUnknownTotal.inc(),
      integrityFailure: ({ reason }) => {
        if (reason === "activity-root-missing") activityOrphanTotal.inc();
      },
    },
    controls,
    log: (event, meta) => logger.info(`[${event}]`, meta),
    onPersisted: ({ envelope, binding, activityRootPostId, outcome }) => {
      activityIntakeTotal.inc({ outcome });
      void tracker.observe({ envelope, binding, activityRootPostId }).catch((error) => {
        logger.error("[activity] coach state projection failed", {
          runId: envelope.ref.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  }));
}

function installProductionScheduledAnchorAdmission(runtimeBroker: OpenClawRuntimeBroker): void {
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!gatewayToken) {
    installScheduledAnchorAdmissionHandler(null);
    return;
  }
  const admission = createScheduledAnchorAdmission({
    broker: runtimeBroker,
    mmClientFor: createActivityMmClientFactory({ baseUrl: MM_INTERNAL_URL }),
    verifyChannel: async (identity, target) => {
      await readMattermostChannelCreateAt({
        baseUrl: MM_INTERNAL_URL,
        channelId: target.primaryChannelId,
        token: identity.coachToken,
        expectedTeamId: target.expectedChannelTeamId,
        expectedName: target.expectedChannelName,
        expectedType: target.expectedChannelType,
      });
    },
    ownerId: `${process.env.HOSTNAME ?? "gateway-edge"}:${process.pid}`,
  });
  installScheduledAnchorAdmissionHandler(createScheduledAnchorAdmissionHandler({
    gatewayToken,
    admit: admission.admit,
    log: (message, fields) => logger.error(`[activity] ${message}`, fields),
  }));
}

async function startRunLiveProjectionBackground(
  gatewayIdResult: ReturnType<typeof resolveBridgeGatewayId>,
  runtimeBroker: OpenClawRuntimeBroker,
): Promise<void> {
  bridgeBootStatus.set(BRIDGE_UNSYNCHRONIZED);
  if (!gatewayIdResult.ok) {
    bridgeBootStatus.set('gateway-id-missing');
    console.error(
      `[chat-proxy] run-live bridge boot aborted — ${gatewayIdResult.reason}. Set GATEWAY_ID on the gateway-edge sidecar.`,
    );
    return;
  }
  const { createControlledRunLiveProjection } = await import(
    './openclaw/run-live-control-projection.js'
  );
  const { connectRunLiveBridgeUpstream } = await import('./openclaw/run-live-bridge-boot.js');
  const namespace = process.env.K8S_NAMESPACE || 'octogee';
  const controlKey = process.env.OCTOGEE_AGENT_CONTROL_SIGNING_SECRET ?? '';
  const routerKey = process.env.AGENT_CONTROL_ROUTER_KEY ?? '';
  const activityMmClientFor = createActivityMmClientFactory({ baseUrl: MM_INTERNAL_URL });
  const receiptsFor = (binding: { channelDocPath: string }) =>
    runtimeBroker.activityWriteReceiptsFor(binding.channelDocPath);
  const resolveCoachToken = async (agentId: string): Promise<string | null> =>
    (await runtimeBroker.resolveAgentIdentity(agentId))?.coachToken ?? null;
  const leaseOwner = `${process.env.HOSTNAME ?? 'gateway-edge'}:${process.pid}`;
  const bindingDeps = {
    resolveAgentIdentity: (agentId: string) => runtimeBroker.resolveAgentIdentity(agentId),
    resolveConversationTarget: (agentId: string, conversationId: string) =>
      runtimeBroker.resolveConversationTarget(agentId, conversationId),
    verifyActivityChannel: (
      identity: import("./openclaw/activity-runtime-types.js").AgentIdentity,
      target: import("./openclaw/activity-runtime-types.js").AuthorizedConversationTarget,
    ) =>
      readMattermostChannelCreateAt({
        baseUrl: MM_INTERNAL_URL,
        channelId: target.activityChannelId,
        token: identity.coachToken,
        expectedTeamId: target.expectedChannelTeamId,
        expectedName: target.expectedChannelName,
        expectedType: target.expectedChannelType,
      }),
    verifyScheduledAnchor: (input: {
      agentId: string;
      invocationId: string;
      target: string;
      rootPostId: string;
      channelDocPath: string;
      coachToken: string;
      coachMmUserId: string;
    }) => verifyScheduledAnchorBinding({
      request: {
        agentId: input.agentId,
        invocationId: input.invocationId,
        target: input.target,
      },
      rootPostId: input.rootPostId,
      coachMmUserId: input.coachMmUserId,
      receipts: runtimeBroker.activityWriteReceiptsFor(input.channelDocPath),
      mm: activityMmClientFor(input.coachToken),
    }),
    verifyRetryLineage: (input: {
      binding: import("./openclaw/activity-intake.js").ActiveActivityRunBinding;
      coachMmUserId: string;
    }) => verifyReceiptBackedRetryLineage({
      ...input,
      receipts: runtimeBroker.activityWriteReceiptsFor(input.binding.channelDocPath),
      mm: activityMmClientFor(input.binding.coachToken),
    }),
    verifyHistoricalSubagentParent: (input: {
      binding: import("./openclaw/activity-intake.js").ActiveActivityRunBinding;
      coachMmUserId: string;
    }) => verifyHistoricalSubagentParent({
      ...input,
      mm: activityMmClientFor(input.binding.coachToken),
    }),
  };
  activityRuntimeRegistry.configureResolver((run, activeLineage) =>
    resolveCandidateActivityBinding(run, bindingDeps, activeLineage),
  );
  const coachTracker = createActivityCoachTracker({
    resolveCoach: async (binding) => {
      const identity = await runtimeBroker.resolveAgentIdentity(binding.agentId);
      if (
        !identity ||
        identity.agentId !== binding.agentId ||
        !identity.coachToken ||
        !identity.coachMmUserId ||
        !identity.workspaceSlug
      ) {
        return null;
      }
      return {
        activityChannelId: binding.activityChannelId,
        coachMmUserId: identity.coachMmUserId,
        coachToken: identity.coachToken,
        workspaceSlug: identity.workspaceSlug,
      };
    },
    readMountedCustomers: readMountedCoachCustomers,
    log: (message, meta) => logger.error(`[activity] ${message}`, meta),
  });
  const retryMarker = createReceiptBackedRetryMarker({
    runtimeRegistry: activityRuntimeRegistry,
    receiptsFor,
    resolveCoachToken,
    mmClientFor: activityMmClientFor,
    leaseOwner,
  });
  const controlled = createControlledRunLiveProjection({
    gatewayId: gatewayIdResult.gatewayId,
    namespace,
    registry: runtimeBroker.agentControlRegistry,
    runtimeRegistry: activityRuntimeRegistry,
    receiptsFor,
    mmClientFor: activityMmClientFor,
    resolveCoachToken,
    triggerVerifier: createMattermostTriggerVerifier({
      source: createMattermostSigningKeySource({ baseUrl: MM_INTERNAL_URL }),
    }),
    controlKey,
    routerKey,
    leaseOwnerId: () => leaseOwner,
    claimToken: randomUUID,
    leaseOwner,
    createRetryMarker: retryMarker,
    resolveChannelTarget: (conversationId) => runtimeBroker.resolveChannelTarget(conversationId),
    resolveAgentIdentity: (agentId) => runtimeBroker.resolveAgentIdentity(agentId),
    replaceRuntimeSnapshot: (snapshot, commitWrites) =>
      replaceCandidateRuntimeSnapshot(
        activityRuntimeRegistry,
        snapshot,
        bindingDeps,
        (runs) => coachTracker.replaceSnapshot(runs),
        commitWrites,
      ),
    writeLiveDoc: (path, doc) => runtimeBroker.writeRunLiveDoc(path, doc),
    deleteLiveDoc: (path) => runtimeBroker.deleteRunLiveDoc(path),
    log: (message, meta) => logger.error(message, meta),
  });
  installAgentControlCallbackHandler(controlled.callbackHandler);
  installProductionActivityIntake(controlled.activityControls, runtimeBroker, coachTracker);
  const liveBridge = controlled.bridge;
  const gatewayId = gatewayIdResult.gatewayId;
  const healthUrl = gatewayHealthUrl();
  let rpc: ActivityBridgeRpcClient | null = null;
  await startCoachEventListeners({
    gatewayId,
    runtimeBroker,
    tracker: coachTracker,
    getRpcClient: () => rpc,
  });
  startBridgeUpstreamReconnectLoop({
    probeReady: () => probeGatewayReady(healthUrl),
    probeIntervalMs: 500,
    openOnce: async () => {
      bridgeBootStatus.set(BRIDGE_UNSYNCHRONIZED);
      const ws = await openBackgroundBridgeUpstream(
        gatewayId,
        process.env.OPENCLAW_GATEWAY_URL ?? DEFAULT_OPENCLAW_GATEWAY_URL,
      );
      let closed = false;
      let onClose: (() => void) | undefined;
      ws.on('close', () => {
        closed = true;
        bridgeBootStatus.set(BRIDGE_UNSYNCHRONIZED);
        onClose?.();
      });
      await connectRunLiveBridgeUpstream(liveBridge, {
        ws,
        log: bridgeLog,
        onRpcChange: (nextRpc) => {
          controlled.setRpc(nextRpc);
          rpc = nextRpc;
        },
        observeUpstreamFrame: controlled.observeUpstreamFrame,
      });
      return {
        onClose(handler: () => void) {
          if (closed) handler();
          else onClose = handler;
        },
      };
    },
    log: bridgeLog,
    onConnected: () => {
      bridgeBootStatus.set('connected');
      console.log('[chat-proxy] run-live projection synchronized');
    },
  });
}

interface ActivityBridgeRpcClient {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

async function startCoachEventListeners(input: {
  gatewayId: string;
  runtimeBroker: OpenClawRuntimeBroker;
  tracker: ActivityCoachTracker;
  getRpcClient(): ActivityBridgeRpcClient | null;
}): Promise<void> {
  const mmWsUrl = MM_PUBLIC_URL.replace(/^http/, 'ws') + '/api/v4/websocket';
  const { startMmCoachEventListeners } = await import('./openclaw/mm-event-listener.js');
  const { handleReactionAdded } = await import('./openclaw/reaction-handler.js');
  const { makeCoachDmHandler } = await import('../notifications/chat-notifier.js');
  const {
    createBrokeredFanOutNotification,
    notificationBrokerBaseUrlFromEnv,
  } = await import('../notifications/broker.js');
  const fanOutNotification = createBrokeredFanOutNotification({
    baseUrl: notificationBrokerBaseUrlFromEnv(),
    gatewayId: input.gatewayId,
  });
  const ownerOf = (channelId: string) => input.runtimeBroker.resolveChannelOwnerUid(channelId);
  const uidOf = (mmUserId: string) => input.runtimeBroker.resolveOctogeeUidByMmUser(mmUserId);
  const coachListeners = startMmCoachEventListeners({
    mmWsUrl,
    log: bridgeLog,
    openWebSocket: () => new WebSocket(mmWsUrl),
    isTrackedChannel: (channelId) => input.tracker.isTrackedActivityChannel(channelId),
    resolveRunForRootPost: (postId) => input.tracker.getRunStateByRootPostId(postId),
    onReaction: async (reaction) => {
      await handleReactionAdded(reaction, {
        resolveRunForRootPost: (postId) => input.tracker.getRunStateByRootPostId(postId),
        resolveChannelOwnerUid: ownerOf,
        resolveOctogeeUidByMmUser: uidOf,
        effects: {
          dispatchAbort: async (sessionKey) => {
            const rpc = input.getRpcClient();
            if (!rpc) {
              console.warn(
                `[reaction-handler] abort dispatch skipped — no upstream RPC client for session ${sessionKey}`,
              );
              return;
            }
            await rpc.call('chat.abort', { sessionKey });
          },
        },
        log: bridgeLog,
        metrics: {
          reactionDispatchMs: activityReactionDispatchMs,
          reactionDropped: new Counter({
            name: 'octogee_activity_reaction_dropped_total',
            help: 'Reaction-handler drops with reason',
            labelNames: ['reason'] as const,
            registers: [metricsRegistry],
          }),
        },
      });
    },
    onCoachDm: makeCoachDmHandler({
      resolveOwnerUid: ownerOf,
      fanOut: fanOutNotification,
      log: bridgeLog,
    }),
  });
  wireActivityCoachEventListeners(input.tracker, coachListeners);
  startActivityCoachMountReconciliation(input.tracker);
  console.log('[chat-proxy] MM coach event listeners started (per-coach WS: reactions + notifications)');
}

type ResolvedBridgeGatewayId = Extract<ReturnType<typeof resolveBridgeGatewayId>, { ok: true }>;

interface ActivityProjectionBootstrap {
  gatewayIdResult: ResolvedBridgeGatewayId;
  gatewayId: string;
  runtimeBroker: OpenClawRuntimeBroker;
}

function bootstrapActivityProjection(): ActivityProjectionBootstrap | null {
  const gatewayIdResult = resolveBridgeGatewayId(process.env);
  if (!gatewayIdResult.ok) {
    console.error(
      `[chat-proxy] activity projection boot aborted — ${gatewayIdResult.reason}. ` +
      'Set GATEWAY_ID env var on the chat-proxy sidecar (helm chart values.env.gatewayId). ' +
      'See the current Activity design documentation.',
    );
    bridgeBootStatus.set('gateway-id-missing');
    return null;
  }
  const gatewayId = gatewayIdResult.gatewayId;
  mattermostInteractionProxyHandler = createMattermostInteractionProxyHandler({
    gatewayId,
    routerKey: process.env.AGENT_CONTROL_ROUTER_KEY ?? '',
    log: (message, meta) => logger.error(message, meta),
  });
  try {
    const runtimeBroker = getOpenClawRuntimeBroker();
    console.log('[chat-proxy] OpenClaw runtime Firestore broker enabled');
    return { gatewayIdResult, gatewayId, runtimeBroker };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[chat-proxy] FATAL: OpenClaw runtime broker misconfigured: ${msg}`);
    process.exit(1);
  }
}

export async function startChatProxyBackground(): Promise<void> {
  warnIfWsOriginsMisconfigured(console.warn);
  console.log(`[chat-proxy] MM internal URL (data path): ${MM_INTERNAL_URL}`);
  void (async () => {
    const bootstrap = bootstrapActivityProjection();
    if (!bootstrap) return;
    const { gatewayIdResult, runtimeBroker } = bootstrap;
    installProductionScheduledAnchorAdmission(runtimeBroker);
    try {
      await startRunLiveProjectionBackground(gatewayIdResult, runtimeBroker);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[chat-proxy] FATAL: activity projection wire failed: ${message}`);
      process.exit(1);
    }
  })();
}
