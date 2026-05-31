import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import admin from "firebase-admin";
import { Registry, Counter, Gauge, Histogram } from "prom-client";
import { buildGatewayMetricsFetcher, startMetricsBaseline } from "./openclaw/metrics-baseline.js";
import { generateIdentity, type DeviceIdentity } from "../../../shared/types/device-identity.js";
import { WsUpgradeRouter } from "../../../shared/ws/upgrade-router.js";
import { openUpstream, OpenclawWireError } from "./openclaw/upstream.js";
import {
  resolveGatewayUrl,
  GatewayResolveError,
} from "./openclaw/gateway-resolver.js";
import { watchGatewayIdChange } from "./openclaw/gateway-id-watcher.js";
import {
  fetchGatewayToken,
  invalidateGatewayToken,
  GatewayTokenError,
} from "./openclaw/gateway-token.js";
import { resolveBridgeGatewayId } from "./openclaw/bridge-gateway-id.js";
import { startBridgeUpstreamReconnectLoop } from "./openclaw/bridge-reconnect.js";
import {
  shouldForwardFrame,
  deriveExpectedAgentId,
  ExpectedAgentIdError,
} from "./openclaw/frame-filter.js";
import {
  createGateState,
  evaluateInboundFrame,
  observeOutboundForState,
} from "./openclaw/inbound-gate.js";
import { isAllowedWsOrigin, warnIfWsOriginsMisconfigured } from "./openclaw/ws-origin.js";
import { applyGatewayPrefixStripInPlace, stripGatewayPrefix } from "./gateway-prefix.js";
import { resolveBuilderShellInternalAuthSecret } from "../lib/builder-shell-internal-auth.js";
import { attachMmWsBridge, createMmWsRegistry, type MmWsRegistry } from "./mm-proxy/ws.js";
import {
  createChannelMemberResolver,
  type ChannelMemberResolver,
} from "./mm-proxy/channel-members.js";
import {
  createBridgeBootStatus,
  bridgeHealthBody,
} from "./openclaw/bridge-boot-status.js";

if (process.env.NODE_ENV !== "test") {
  if (!process.env.MM_INTERNAL_URL) {
    console.error("FATAL: MM_INTERNAL_URL is required (in-cluster Mattermost URL, e.g. http://mattermost.<ns>.svc.cluster.local:8065)");
    process.exit(1);
  }
}
const MM_INTERNAL_URL = process.env.MM_INTERNAL_URL || "https://mm-test.invalid";
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT || "octogee";
const SA_KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.SA_KEY_PATH;

const MM_PUBLIC_URL = MM_INTERNAL_URL;

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

async function fetchMmChannelMemberIds(
  mmInternalUrl: string,
  adminPat: string,
  channelId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const MAX_PAGES = 25;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await fetch(
      `${mmInternalUrl}/api/v4/channels/${channelId}/members?page=${page}&per_page=200`,
      { headers: { Authorization: `Bearer ${adminPat}` } },
    );
    if (!resp.ok) {
      throw new Error(`MM channel members ${channelId} → ${resp.status}`);
    }
    const batch = (await resp.json()) as Array<{ user_id?: unknown }>;
    for (const m of batch) {
      if (typeof m.user_id === "string") ids.add(m.user_id);
    }
    if (batch.length < 200) return ids;

if (page === MAX_PAGES - 1) {
      throw new Error(
        `MM channel members ${channelId} exceeded ${MAX_PAGES * 200} — refusing partial set`,
      );
    }
  }
  return ids;
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

const builderShellSessionCloseTotal = new Counter({
  name: 'chat_proxy_builder_shell_session_close_total',
  help: 'Builder-shell session close events, by reason (client-disconnect / upstream-disconnect / upstream-error / upstream-unreachable / backpressure-*). Does NOT include invalid-ticket rejections — those are counted separately on chat_proxy_builder_shell_rejected_total.',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

const builderShellRejectedTotal = new Counter({
  name: 'chat_proxy_builder_shell_rejected_total',
  help: 'Builder-shell ticket rejections (invalid/expired/replayed). Separate from session_close_total so session-close alerting is not muddled by ticket-mint/redeem mismatch.',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

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

const ocPluginLookupDurationMs = new Histogram({
  name: 'octogee_oc_plugin_lookup_duration_ms',
  help: 'OpenClaw plugin lookup duration scraped from gateway /metrics, by stage',
  labelNames: ['stage'] as const,
  buckets: [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [metricsRegistry],
});

const bridgeMetrics = {
  eventsReceived: new Counter({
    name: 'octogee_bridge_event_received_total',
    help: 'Agent events received by the activity bridge from the gateway upstream WS',
    labelNames: ['stream'] as const,
    registers: [metricsRegistry],
  }),
  eventsPosted: new Counter({
    name: 'octogee_bridge_event_posted_total',
    help: 'Agent events successfully posted/edited to the activity channel',
    labelNames: ['stream', 'kind'] as const,
    registers: [metricsRegistry],
  }),
  eventsDropped: new Counter({
    name: 'octogee_bridge_event_dropped_total',
    help: 'Agent events dropped by the bridge with structured reason',
    labelNames: ['stream', 'reason'] as const,
    registers: [metricsRegistry],
  }),
  postLatencyMsCreate: new Histogram({
    name: 'octogee_bridge_mm_post_create_ms',
    help: 'MM createPost latency from the bridge',
    labelNames: ['kind', 'status_class'] as const,
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    registers: [metricsRegistry],
  }),
  postLatencyMsEdit: new Histogram({
    name: 'octogee_bridge_mm_post_edit_ms',
    help: 'MM editPost latency from the bridge',
    labelNames: ['kind', 'status_class'] as const,
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    registers: [metricsRegistry],
  }),
  resolutionMs: new Histogram({
    name: 'octogee_bridge_resolution_ms',
    help: 'Agent identity + channel resolution latency',
    labelNames: ['outcome'] as const,
    buckets: [0.5, 1, 5, 10, 25, 50, 100, 250, 500],
    registers: [metricsRegistry],
  }),
  approvalDispatchMs: new Histogram({
    name: 'octogee_bridge_approval_dispatch_ms',
    help: 'Approval-callback dispatch latency to OC typed RPC',
    labelNames: ['outcome'] as const,
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500],
    registers: [metricsRegistry],
  }),
  reactionDispatchMs: new Histogram({
    name: 'octogee_bridge_reaction_dispatch_ms',
    help: 'MM reaction → OC abort/redirect dispatch latency',
    labelNames: ['emoji', 'outcome'] as const,
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500],
    registers: [metricsRegistry],
  }),
  e2eRootPostMs: new Histogram({
    name: 'octogee_bridge_e2e_root_post_ms',
    help: 'End-to-end lifecycle.start → root post visible',
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    registers: [metricsRegistry],
  }),
  e2eApprovalVisibleMs: new Histogram({
    name: 'octogee_bridge_e2e_approval_visible_ms',
    help: 'End-to-end approval click → buttons removed',
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    registers: [metricsRegistry],
  }),
  upstreamReconnects: new Counter({
    name: 'octogee_bridge_upstream_reconnects_total',
    help: 'Bridge upstream-WS reconnect count',
    registers: [metricsRegistry],
  }),
  sessionSubscribe: new Counter({
    name: 'octogee_bridge_session_subscribe_total',
    help: 'Bridge upstream sessions.subscribe outcome (ok|failed)',
    labelNames: ['outcome'] as const,
    registers: [metricsRegistry],
  }),
};

const approvalDroppedCounter = new Counter({
  name: 'octogee_bridge_approval_dropped_total',
  help: 'Approval callback drops with reason',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

const memberResolveFailuresTotal = new Counter({
  name: 'octogee_bridge_member_resolve_failures_total',
  help: 'Activity-channel membership resolution failures (ctx fan-out fails closed)',
  registers: [metricsRegistry],
});
const lastMemberResolveWarnByChannel = new Map<string, number>();

function makeScopedFrameEmitter<P extends object>(
  event: string,
  channelMembers: ChannelMemberResolver,
  registry: MmWsRegistry,
  chains: Map<string, Promise<void>>,
): (channelId: string, payload: P) => void {
  return (channelId, payload) => {
    const prev = chains.get(channelId) ?? Promise.resolve();
    const next = prev
      .then(() => channelMembers.getMembers(channelId))
      .then((members) => {
        registry.broadcast(
          { event, data: { channelId, ...payload } },
          (mmUserId) => mmUserId !== null && members.has(mmUserId),
        );
      })
      .catch(() => {
        // resolver already fails closed; nothing to recover
      });
    chains.set(channelId, next);
  };
}

function makeEmitEphemeral(
  channelMembers: ChannelMemberResolver,
  registry: MmWsRegistry,
  chains: Map<string, Promise<void>>,
): (channelId: string, payload: { pct: number | null; used: number; limit: number }) => void {
  return makeScopedFrameEmitter("octogee.ctx", channelMembers, registry, chains);
}

function makeEmitPhase(
  channelMembers: ChannelMemberResolver,
  registry: MmWsRegistry,
  chains: Map<string, Promise<void>>,
): (
  channelId: string,
  payload: {
    status: string | null;
    planTitle: string | null;
    planSteps: string[];
    terminal: string | null;
  },
) => void {
  return makeScopedFrameEmitter("octogee.phase", channelMembers, registry, chains);
}

function reportMemberResolveFailure(channelId: string, err: unknown): void {
  memberResolveFailuresTotal.inc();
  const nowMs = Date.now();
  const last = lastMemberResolveWarnByChannel.get(channelId) ?? 0;
  if (nowMs - last > FRAME_DROP_LOG_WINDOW_MS) {
    lastMemberResolveWarnByChannel.set(channelId, nowMs);
    console.warn(
      `[mm-proxy/channel-members] membership resolve failed for ${channelId} — ` +
        `ctx meter fails closed (delivers to nobody) until it recovers: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const bridgeBootStatusGauge = new Gauge({
  name: 'octogee_bridge_boot_status',
  help: 'Activity bridge boot state — one label is 1, the rest 0',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

const bridgeBootStatus = createBridgeBootStatus({
  gauge: bridgeBootStatusGauge,
  log: (msg) => console.warn(msg),
});

let approvalCallbackHandler:
  | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)
  | null = null;

const FRAME_DROP_LOG_WINDOW_MS = 60_000;
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

let openclawIdentity: DeviceIdentity | null = null;
function getOpenClawIdentity(): DeviceIdentity {
  if (!openclawIdentity) openclawIdentity = generateIdentity();
  return openclawIdentity;
}

if (!admin.apps.length) {
  if (SA_KEY_PATH) {
    const fs = await import("node:fs");
    const sa = JSON.parse(fs.readFileSync(SA_KEY_PATH, "utf-8"));
    admin.initializeApp({ credential: admin.credential.cert(sa), projectId: FIREBASE_PROJECT });
    console.log(`[chat-proxy] Using SA key: ${SA_KEY_PATH}`);
  } else {
    admin.initializeApp({ projectId: FIREBASE_PROJECT });
    console.log(`[chat-proxy] Using ADC for project: ${FIREBASE_PROJECT}`);
  }
}
const db = admin.firestore();

export async function verifyAuth(req: http.IncomingMessage): Promise<string | null> {
  const authHeader = req.headers.authorization;

  let token: string | null = null;
  if (authHeader?.startsWith("Bearer ")) token = authHeader.slice(7);
  else if (authHeader?.startsWith("BEARER ")) token = authHeader.slice(7);
  else if (authHeader?.startsWith("Token ")) token = authHeader.slice(6);

  if (!token) return null;

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch (e) {
    const code =
      typeof e === 'object' && e !== null
        ? (e as { code?: string }).code
        : undefined;
    console.error(`[proxy] auth failed: ${code || (e instanceof Error ? e.message : String(e))}`);
    return null;
  }
}

const ALLOWED_ORIGINS = new Set([
  "https://octogee.web.app",
  "https://octogee-test.web.app",
  "https://app-octogee.web.app",
  "https://app-octogee-test.web.app",
  "https://octogee.firebaseapp.com",
  "https://octogee-test.firebaseapp.com",
  "https://app-octogee.firebaseapp.com",
  "https://app-octogee-test.firebaseapp.com",
  "https://octogee.com",
  "https://www.octogee.com",
  "https://app.octogee.com",
]);

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.has(origin) || /^http:\/\/localhost:\d+$/.test(origin);
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

export function chatProxyOwnsHttpPath(strippedPath: string): boolean {
  return (
    strippedPath === "/healthz" ||
    strippedPath === "/healthz/bridge" ||
    strippedPath === "/api/openclaw/approval/callback"
  );
}

export async function chatProxyHandleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

const urlPath = applyGatewayPrefixStripInPlace(req);

  if (urlPath === "/healthz" || urlPath === "/health" || urlPath === "/_health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (urlPath === "/healthz/bridge") {

res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(bridgeHealthBody(bridgeBootStatus.snapshot(), Date.now())));
    return;
  }

  if (urlPath === "/api/openclaw/approval/callback") {
    if (!approvalCallbackHandler) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "service_unavailable", reason: "approval handler not initialized" }),
      );
      return;
    }
    return approvalCallbackHandler(req, res);
  }

  req.resume();
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

type UpstreamOutcome =
  | { ok: true; upstream: WebSocket }
  | { ok: false; httpStatus: string };

async function establishUpstreamWithRotation(
  gatewayId: string,
  gatewayUrl: string,
): Promise<UpstreamOutcome> {
  let token: string;
  try {
    token = await fetchGatewayToken({ gatewayId });
  } catch (e) {
    if (e instanceof GatewayTokenError) {
      console.error(`[proxy] OC WS: token fetch failed — ${e.code}: ${e.message}`);
      return { ok: false, httpStatus: "503 Service Unavailable" };
    }
    throw e;
  }

  const tryOpen = (authToken: string) =>
    openUpstream({ url: gatewayUrl, token: authToken, identity: getOpenClawIdentity() });

  try {
    const upstream = await tryOpen(token);
    ocWsHandshakeTotal.inc({ outcome: "ok" });
    return { ok: true, upstream };
  } catch (e) {
    const code = e instanceof OpenclawWireError ? e.code : "unknown";
    if (code !== "auth-failed") {
      console.log(`[proxy] OC WS: upstream handshake failed — ${code}`);
      ocWsHandshakeTotal.inc({ outcome: `fail:${code}` });
      return { ok: false, httpStatus: "502 Bad Gateway" };
    }

    invalidateGatewayToken(gatewayId);
    let fresh: string;
    try {
      fresh = await fetchGatewayToken({ gatewayId, skipCache: true });
    } catch (fetchErr) {
      const fetchCode =
        fetchErr instanceof GatewayTokenError ? fetchErr.code : "unknown";
      console.error(
        `[proxy] OC WS: token re-fetch during rotation failed — ${fetchCode}`,
      );
      ocWsHandshakeTotal.inc({ outcome: `fail:refetch:${fetchCode}` });
      return { ok: false, httpStatus: "503 Service Unavailable" };
    }

    try {
      const upstream = await tryOpen(fresh);
      ocWsHandshakeTotal.inc({ outcome: "ok" });
      ocWsRotationRecoveredTotal.inc();
      return { ok: true, upstream };
    } catch (retryErr) {
      const retryCode =
        retryErr instanceof OpenclawWireError ? retryErr.code : "unknown";
      console.log(
        `[proxy] OC WS: upstream handshake failed after rotation retry — ${retryCode}`,
      );
      ocWsHandshakeTotal.inc({ outcome: `fail:${retryCode}` });
      return { ok: false, httpStatus: "502 Bad Gateway" };
    }
  }
}

function handleOpenClawWsUpgrade(
  wss: WebSocketServer,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
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
      const ticketRef = db.doc(`ocTickets/${ticket}`);

      const TICKET_INVALID = "TICKET_INVALID";
      let uid: string;
      try {
        uid = await db.runTransaction<string>(async (tx) => {
          const snap = await tx.get(ticketRef);
          if (!snap.exists) throw new Error(TICKET_INVALID);
          const data = snap.data() ?? {};
          const expiresAt = data.expiresAt;
          const claimUid = data.uid;
          if (typeof expiresAt !== "number" || expiresAt < Date.now()) {
            throw new Error(TICKET_INVALID);
          }
          if (typeof claimUid !== "string" || claimUid.length === 0) {
            throw new Error(TICKET_INVALID);
          }
          tx.delete(ticketRef);
          return claimUid;
        });
      } catch (e) {
        if (e instanceof Error && e.message === TICKET_INVALID) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        throw e;
      }

      let gatewayUrl: string;
      let gatewayId: string;
      let userData: Record<string, unknown>;
      try {
        const resolved = await resolveGatewayUrl({ db, uid });
        gatewayUrl = resolved.url;
        gatewayId = resolved.gatewayId;
        userData = resolved.userData;
      } catch (e) {
        if (e instanceof GatewayResolveError) {
          console.log(`[proxy] OC WS: resolve failed — ${e.code}: ${e.message}`);
          socket.write("HTTP/1.1 502 Not Provisioned\r\n\r\n");
          socket.destroy();
          return;
        }
        throw e;
      }

      let expectedAgentId: string;
      try {
        expectedAgentId = deriveExpectedAgentId(uid, userData);
      } catch (e) {
        if (e instanceof ExpectedAgentIdError) {
          console.error(`[proxy] OC WS: expectedAgentId derive failed — ${e.message}`);
          socket.write("HTTP/1.1 502 Not Provisioned\r\n\r\n");
          socket.destroy();
          return;
        }
        throw e;
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

const stopGatewayWatch = watchGatewayIdChange(
          db,
          uid,
          gatewayId,
          (newGatewayId) => {
            console.log(
              `[proxy] OC WS: gatewayId changed for uid=${uid}: ${gatewayId} → ${newGatewayId}; forcing reconnect`,
            );
            try {
              clientWs.close(1001, "gatewayId-changed");
            } catch {
              // best-effort
            }
          },
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
}

export function gatewayHealthUrl(
  base: string = process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789",
): string {
  return `${base}/healthz`;
}

export function attachChatProxyWsUpgrade(server: http.Server) {
  const wss = new WebSocketServer({ noServer: true });
  const mmWss = new WebSocketServer({ noServer: true });

const wsRouter = new WsUpgradeRouter();

  server.on("upgrade", (req, socket, head) => {
    
    const originalUrl = req.url ?? "(none)";

const urlPath = applyGatewayPrefixStripInPlace(req);
    if (urlPath.startsWith("/api/openclaw/ws/")) {
      handleOpenClawWsUpgrade(wss, req, socket, head);
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
            log: (msg) => console.warn(msg),
            resolveMmUserId,
            openUpstream: (url) => new WebSocket(url),
            registry: mmWsRegistry,
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

export async function attachBuilderShellRoute(server: http.Server): Promise<void> {
  const gatewayEdgeUrl = process.env.GATEWAY_EDGE_INTERNAL_URL;
  const internalAuth = resolveBuilderShellInternalAuthSecret(process.env);
  const namespace = process.env.K8S_NAMESPACE || "octogee";
  if (!gatewayEdgeUrl || !internalAuth) {
    console.warn(
      "[builder-shell] GATEWAY_EDGE_INTERNAL_URL or builder-shell internal auth unset — builder-shell WS disabled",
    );
    return;
  }
  const { buildRedeemFetcher } = await import("./builder-shell/redeem.js");
  const { buildConnectUpstream } = await import("./builder-shell/upstream.js");
  const { attachBuilderShellUpgrade } = await import("./builder-shell/upgrade.js");
  const router = (server as unknown as { wsRouter: WsUpgradeRouter }).wsRouter;
  attachBuilderShellUpgrade(server, {
    router,
    redeem: buildRedeemFetcher({
      baseUrl: gatewayEdgeUrl,
      internalServiceKey: internalAuth.value,
    }),
    connectUpstream: buildConnectUpstream({
      namespace,
      internalServiceKey: internalAuth.value,
    }),

allowedOrigins: isAllowedWsOrigin,
    onEvent: (e) => {
      if (e.kind === "session-attached") {
        // Presence flip happens HERE, not at redeem-time — the upstream
        // WS is confirmed live (ATTACHED received), so flipping
        // currentAttacherUid can't kick the prior user only to strand
        // them when the new dial later fails.
        import("../lib/shell-presence.js")
          .then(({ recordShellAttach }) =>
            recordShellAttach({
              containerSlug: e.containerSlug,
              shellId: e.shellId,
              attacherUid: e.uid,
              sessionId: e.sessionId,
            }),
          )
          .catch((err) => {
            console.error("[builder-shell] presence attach failed", {
              sessionId: e.sessionId,
              shellId: e.shellId,
              err: err instanceof Error ? err.message : String(err),
            });
          });
        return;
      }
      if (e.kind === "session-closed") {
        builderShellSessionCloseTotal.inc({ reason: e.reason });
        console.warn(
          `[builder-shell] session closed sessionId=${e.sessionId} uid=${e.uid} gatewayId=${e.gatewayId} reason=${e.reason}`,
        );
        // Clear shell-doc presence + close the audit row in parallel.
        // recordShellDetach is guarded against stale closes after a
        // takeover (it only clears if currentAttacherUid still matches
        // the detacher). closeAuditRow is idempotent — won't overwrite
        // a 'taken-over' status that recordShellAttach set already.
        import("../lib/shell-presence.js")
          .then(async ({ recordShellDetach, closeAuditRow }) => {
            const isError =
              e.reason === "upstream-unreachable" || e.reason === "upstream-error";
            await Promise.allSettled([
              recordShellDetach({
                containerSlug: e.containerSlug,
                shellId: e.shellId,
                detacherUid: e.uid,
              }),
              closeAuditRow({
                sessionId: e.sessionId,
                status: isError ? "errored" : "closed",
                error: isError ? e.reason : undefined,
              }),
            ]);
          })
          .catch((err) => {
            console.error("[builder-shell] presence/audit close failed", {
              sessionId: e.sessionId,
              shellId: e.shellId,
              err: err instanceof Error ? err.message : String(err),
            });
          });
        return;
      }
      // 'rejected' — counted separately so session-close baselines
      // aren't polluted by invalid-ticket events.
      builderShellRejectedTotal.inc({ reason: e.reason });
      console.warn(`[builder-shell] ticket rejected reason=${e.reason}`);
    },
  });
  console.log(
    `[builder-shell] WS route attached (gateway-edge=${gatewayEdgeUrl}, ns=${namespace}, auth=${internalAuth.mode})`,
  );
}

async function buildEditDiffFetcher() {
  const giteaToken = process.env.GITEA_TOKEN;
  if (!giteaToken || giteaToken.trim().length === 0) {
    console.warn(
      '[chat-proxy] GITEA_TOKEN not set — edit diffs will render as placeholders. ' +
      'Mount K8s secret `gitea-token/token` on chat-proxy to enable.',
    );
    return undefined;
  }
  const ns = process.env.K8S_NAMESPACE || 'octogee';

const giteaUrl = `http://octogee-gitea-http.${ns}.svc.cluster.local:3000`;
  const giteaPublicBaseUrl = process.env.GITEA_PUBLIC_BASE_URL || undefined;
  const { createGiteaEditDiffFetcher } = await import('./openclaw/gitea-edit-diff-fetcher.js');
  return createGiteaEditDiffFetcher({
    giteaUrl,
    giteaToken,
    giteaPublicBaseUrl,
    log: (msg) => console.warn(msg),
  });
}

export async function startChatProxyBackground(): Promise<void> {
  warnIfWsOriginsMisconfigured(console.warn);
  console.log(`[chat-proxy] MM internal URL (data path): ${MM_INTERNAL_URL}`);

  startMetricsBaseline({
    fetchGatewayMetrics: buildGatewayMetricsFetcher(process.env),
    intervalMs: 30_000,
    log: (msg) => console.warn(msg),
    onSample: (sample) => {
      ocPluginLookupDurationMs.observe({ stage: 'registrySnapshot' }, sample.registrySnapshotMs);
      ocPluginLookupDurationMs.observe({ stage: 'manifestRegistry' }, sample.manifestRegistryMs);
      ocPluginLookupDurationMs.observe({ stage: 'startupPlan' }, sample.startupPlanMs);
      ocPluginLookupDurationMs.observe({ stage: 'ownerMaps' }, sample.ownerMapsMs);
      ocPluginLookupDurationMs.observe({ stage: 'total' }, sample.totalMs);
    },
  });

  void (async () => {
    const mmAdminPat = process.env.MM_ADMIN_PAT ?? '';
    if (!mmAdminPat || mmAdminPat.trim().length === 0) {
      console.warn(
        '[chat-proxy] MM_ADMIN_PAT not mounted — skipping activity bridge boot. ' +
        'Mount K8s secret `mattermost-gateway/admin_token` to enable. See ' +
        'helm/octogee/charts/gateway/templates/deployment.yaml.',
      );
      bridgeBootStatus.set('mm-admin-pat-missing');
      return;
    }

const channelMembers = createChannelMemberResolver({
      ttlMs: 60_000,
      fetchMembers: (channelId: string) =>
        fetchMmChannelMemberIds(MM_INTERNAL_URL, mmAdminPat, channelId),
      onError: reportMemberResolveFailure,
    });
    const ctxEmitChains = new Map<string, Promise<void>>();
    const phaseEmitChains = new Map<string, Promise<void>>();
    const { wireActivityBridge, connectBridgeUpstream } = await import('./openclaw/bridge-boot.js');
    let wired: Awaited<ReturnType<typeof wireActivityBridge>>;
    try {
      wired = wireActivityBridge({
        db: db as unknown as Parameters<typeof wireActivityBridge>[0]['db'],
        upstreamUrl: process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789',
        gatewayToken: '',
        mmAdminPat,
        identity: getOpenClawIdentity(),
        mmBaseUrl: MM_PUBLIC_URL,
        metrics: { ...bridgeMetrics, approvalDropped: approvalDroppedCounter },
        log: (msg) => console.warn(msg),
        editDiffFetcher: await buildEditDiffFetcher(),
        emitEphemeral: makeEmitEphemeral(channelMembers, mmWsRegistry, ctxEmitChains),
        emitPhase: makeEmitPhase(channelMembers, mmWsRegistry, phaseEmitChains),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[chat-proxy] FATAL: activity bridge wire failed: ${msg}`);
      process.exit(1);
    }
    approvalCallbackHandler = wired.approvalCallbackHandler;

    const gatewayIdResult = resolveBridgeGatewayId(process.env);
    if (!gatewayIdResult.ok) {
      console.error(
        `[chat-proxy] activity bridge boot aborted — ${gatewayIdResult.reason}. ` +
        'Set GATEWAY_ID env var on the chat-proxy sidecar (helm chart values.env.gatewayId). ' +
        'See docs/ACTIVITY-STREAM-SPEC.md Appendix A.1.',
      );
      bridgeBootStatus.set('gateway-id-missing');
      return;
    }
    const gatewayId = gatewayIdResult.gatewayId;

    const mmWsUrl = MM_PUBLIC_URL.replace(/^http/, 'ws') + '/api/v4/websocket';
    const { startMmEventListener } = await import('./openclaw/mm-event-listener.js');
    const { handleReactionAdded } = await import('./openclaw/reaction-handler.js');
    const { resolveChannelOwnerUid } = await import('./openclaw/owner-resolution.js');
    const getRpcClient = (): { call: (m: string, p: Record<string, unknown>) => Promise<unknown> } | null => {
      const wiredAny = wired as unknown as {
        __getRpcClient?: () => { call: (m: string, p: Record<string, unknown>) => Promise<unknown> } | null;
      };
      return wiredAny.__getRpcClient?.() ?? null;
    };
    startMmEventListener({
      mmWsUrl,
      mmAdminPat,
      log: (msg) => console.warn(msg),
      openWebSocket: () => new WebSocket(mmWsUrl),
      isTrackedChannel: (channelId) =>
        wired.handle.isTrackedActivityChannel?.(channelId) ?? false,
      resolveRunForRootPost: (postId) =>
        wired.handle.getRunStateByRootPostId?.(postId) ?? null,
      onReply: async (reply) => {
        const rpc = getRpcClient();
        if (!rpc) {
          console.warn(
            `[mm-event-listener] reply-as-steer skipped — no upstream RPC client for session ${reply.sessionKey}`,
          );
          return;
        }
        try {
          await rpc.call('chat.send', {
            sessionKey: reply.sessionKey,
            message: reply.message,
            deliver: false,
            idempotencyKey: reply.replyPostId,
          });
        } catch (err) {
          console.warn(
            `[mm-event-listener] chat.send (reply-as-steer) failed for session ${reply.sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      onReaction: async (reaction) => {
        await handleReactionAdded(reaction, {
          resolveRunForRootPost: (postId) =>
            wired.handle.getRunStateByRootPostId?.(postId) ?? null,
          resolveChannelOwnerUid: (channelId) =>
            resolveChannelOwnerUid(channelId, {
              db: db as never,
              log: (msg) => console.warn(msg),
            }),
          resolveOctogeeUidByMmUser: async (mmUserId) => {
            try {
              const snap = await db
                .collection('users' as never)
                .where('mattermost.userId' as never, '==' as never, mmUserId as never)
                .get();
              const docs = (snap as unknown as { docs: Array<{ id: string }> }).docs;
              return docs[0]?.id ?? null;
            } catch (err) {
              console.warn(
                `[reaction-handler] resolveOctogeeUidByMmUser failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              return null;
            }
          },
          effects: {
            dispatchAbort: async (sessionKey) => {
              const rpc = getRpcClient();
              if (!rpc) {
                console.warn(
                  `[reaction-handler] abort dispatch skipped — no upstream RPC client for session ${sessionKey}`,
                );
                return;
              }
              await rpc.call('chat.abort', { sessionKey });
            },
          },
          log: (msg) => console.warn(msg),
          metrics: {
            reactionDispatchMs: bridgeMetrics.reactionDispatchMs,
            reactionDropped: new Counter({
              name: 'octogee_bridge_reaction_dropped_total',
              help: 'Reaction-handler drops with reason',
              labelNames: ['reason'] as const,
              registers: [metricsRegistry],
            }),
          },
        });
      },
    });
    console.log('[chat-proxy] MM event listener started (reactions + reply-as-steer)');

const healthUrl = gatewayHealthUrl();
    startBridgeUpstreamReconnectLoop({
      probeReady: () => probeGatewayReady(healthUrl),
      probeIntervalMs: 500,
      openOnce: async () => {
        let tokenResolved: string;
        let ws: Awaited<ReturnType<typeof openUpstream>>;
        try {
          tokenResolved = await fetchGatewayToken({ gatewayId });
          ws = await openUpstream({
            url: process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789',
            token: tokenResolved,
            identity: getOpenClawIdentity(),
          });
        } catch (err) {
          const code = err instanceof OpenclawWireError ? err.code : undefined;
          bridgeBootStatus.set(code === 'auth-failed' ? 'auth-failed' : 'unreachable');
          throw err;
        }
        let closed = false;
        let registered: (() => void) | null = null;
        ws.on('close', () => {
          closed = true;
          bridgeBootStatus.set('unreachable');
          registered?.();
        });
        await connectBridgeUpstream(wired, {
          ws,
          log: (msg) => console.warn(msg),
          metrics: bridgeMetrics,
        });
        return {
          onClose: (handler) => {
            if (closed) {
              handler();
            } else {
              registered = handler;
            }
          },
        };
      },
      log: (msg) => console.warn(msg),
      onConnected: () => {
        bridgeBootStatus.set('connected');
        console.log('[chat-proxy] activity bridge upstream WS connected');
      },
    });
  })();
}
