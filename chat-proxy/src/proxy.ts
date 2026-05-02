/**
 * Octogee Chat Proxy — Firebase Auth → Mattermost credential mint + OpenClaw bridge
 *
 * Stateless service with two responsibilities:
 *
 *   1. POST /api/auth/mattermost — exchange a Firebase ID token for the user's
 *      Mattermost credentials. Browser then talks to Mattermost directly at
 *      MM_PUBLIC_URL using its personal access token.
 *
 *   2. WS /api/openclaw/ws/<ticket> — bridge the browser to the user's
 *      assigned OpenClaw gateway, with per-user frame filtering. The browser
 *      gets a normal WebSocket; this service handles the Ed25519 device
 *      handshake, gateway-token rotation, and cross-user fan-out blocking.
 *
 * Mattermost REST and WebSocket traffic is NOT proxied here any more. The
 * Mattermost ingress (mattermost[-test].octogee.com, IAP off) is the path
 * for that. See docs/RUNBOOK.md for the Option-C migration notes.
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import admin from "firebase-admin";
import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from "prom-client";
import { startMetricsBaseline } from "./openclaw/metrics-baseline.js";
import {
  startActivityBridge,
  type ActivityBridgeHandle,
  type AgentEventPayload,
} from "./openclaw/activity-bridge.js";
import { createApprovalCallbackHandler } from "./openclaw/approval-callback.js";
import { signApprovalContext } from "./openclaw/approval-callback.js";
import { createMmClientFactory } from "./openclaw/mm-client.js";
import { generateIdentity, type DeviceIdentity } from "./openclaw/device-identity.js";
import { openUpstream, UpstreamError } from "./openclaw/upstream.js";
import {
  resolveGatewayUrl,
  GatewayResolveError,
} from "./openclaw/gateway-resolver.js";
import {
  fetchGatewayToken,
  invalidateGatewayToken,
  GatewayTokenError,
} from "./openclaw/gateway-token.js";
import {
  shouldForwardFrame,
  deriveExpectedAgentId,
  ExpectedAgentIdError,
} from "./openclaw/frame-filter.js";

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8080", 10);
// Public-facing URL of the Mattermost ingress (e.g. https://mattermost.octogee.com).
// Returned to the browser by the credential-mint endpoint so the client can
// hit MM directly. Required — the chart wraps it with `required` at render
// time but we still defensively process.exit(1) here to catch a manually
// applied manifest with the env stripped.
const MM_PUBLIC_URL = process.env.MM_PUBLIC_URL;
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT || "octogee";
const SA_KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.SA_KEY_PATH;

if (!MM_PUBLIC_URL) {
  console.error("FATAL: MM_PUBLIC_URL is required");
  process.exit(1);
}

// ── Prometheus metrics ────────────────────────────────────────────────────────

const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

const mintRequestsTotal = new Counter({
  name: 'chat_proxy_mint_requests_total',
  help: 'Mattermost credential-mint requests',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

// OpenClaw gateway proxy counters — separate label space so dashboards
// don't conflate MM WS traffic with OC WS traffic.
const ocWsConnectionsActive = new Gauge({
  name: 'chat_proxy_openclaw_ws_connections_active',
  help: 'Active OpenClaw gateway proxy connections',
  registers: [metricsRegistry],
});

const ocWsHandshakeTotal = new Counter({
  name: 'chat_proxy_openclaw_ws_handshakes_total',
  help: 'Total OpenClaw upstream handshake outcomes',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

// Separate counter for successful rotation-recovery attempts. Stays out of
// `ocWsHandshakeTotal` (which counts first-try outcomes) so alerting on a
// sustained high rotation-recovery rate is straightforward: it would mean
// the gateway pod is cycling more often than expected.
const ocWsRotationRecoveredTotal = new Counter({
  name: 'chat_proxy_openclaw_ws_rotation_recovered_total',
  help: 'OpenClaw upstream handshakes that succeeded after an auth-failed rotation retry',
  registers: [metricsRegistry],
});

// Per-user frame-filter counters (#728). `decision`=forward|drop. Forward
// reasons: matched-identity / system-event / non-event-frame / unparseable.
// Drop reasons: identity-mismatch / missing-identity / unknown-event-class.
// A non-zero `drop` rate is the canary for cross-user gateway broadcast
// being intercepted before it reaches the wrong browser.
const ocWsFrameFilterTotal = new Counter({
  name: 'chat_proxy_openclaw_ws_frame_filter_total',
  help: 'Per-user frame-filter decisions on inbound gateway events',
  labelNames: ['decision', 'reason'] as const,
  registers: [metricsRegistry],
});

// Phase 0.5: capture OC plugin-load-per-turn timings as a no-regression
// baseline before Phase 1 ships. See docs/ACTIVITY-STREAM-SPEC.md §9.3.
const ocPluginLookupDurationMs = new Histogram({
  name: 'octogee_oc_plugin_lookup_duration_ms',
  help: 'OpenClaw plugin lookup duration scraped from gateway /metrics, by stage',
  labelNames: ['stage'] as const,
  // Buckets sized for typical plugin-lookup observations (sub-ms to ~1s).
  buckets: [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [metricsRegistry],
});

// ── Activity bridge metrics (Phase 1, spec §9.1) ──────────────────────────────
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
};

const approvalDroppedCounter = new Counter({
  name: 'octogee_bridge_approval_dropped_total',
  help: 'Approval callback drops with reason',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

// Activity bridge runtime state. Initialized at boot (see bottom of file)
// when NODE_ENV !== "test"; in test mode the proxy serves but the bridge
// stays unwired (test mode protects against accidental upstream connects).
// The approval callback HTTP route at handleRequest checks this against
// null and returns 503 to surface "service not initialized" honestly.
let approvalCallbackHandler:
  | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)
  | null = null;

// Per-uid sample rate for the drop warn-log. The Prom counter above is the
// canonical signal; the log line is forensic context for the FIRST hit per
// uid in a 60s window. A real cross-user incident could otherwise produce
// dozens of warn lines per dropped frame and bury the real signal.
const FRAME_DROP_LOG_WINDOW_MS = 60_000;
const lastFrameDropLogByUid = new Map<string, number>();

// OpenClaw gateway auth token is fetched from Secret Manager per-request
// (see ./openclaw/gateway-token.ts). The gateway publishes a fresh token
// on every pod boot under `gateway-auth-token-{gatewayId}`; chat-proxy
// caches briefly and invalidates on auth-failed to pick up rotations
// within one upgrade attempt. Device identity is generated once per pod
// — OpenClaw grants scopes by the token + signed payload, not by any
// pre-registered identity, so in-memory is fine.
let openclawIdentity: DeviceIdentity | null = null;
function getOpenClawIdentity(): DeviceIdentity {
  if (!openclawIdentity) openclawIdentity = generateIdentity();
  return openclawIdentity;
}

// Initialize Firebase Admin — use explicit SA key if provided (cross-project),
// otherwise fall back to ADC (same-project).
if (SA_KEY_PATH) {
  const fs = await import("node:fs");
  const sa = JSON.parse(fs.readFileSync(SA_KEY_PATH, "utf-8"));
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: FIREBASE_PROJECT });
  console.log(`[chat-proxy] Using SA key: ${SA_KEY_PATH}`);
} else {
  admin.initializeApp({ projectId: FIREBASE_PROJECT });
  console.log(`[chat-proxy] Using ADC for project: ${FIREBASE_PROJECT}`);
}
const db = admin.firestore();

// ── MM credential cache ───────────────────────────────────────────────────────

interface CachedMmCreds {
  mmToken: string;
  mmUserId: string;
  expiresAt: number;
}

const mmCredsCache = new Map<string, CachedMmCreds>();
const MM_CREDS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Result discriminator: differentiate "user has no MM provisioning yet"
 * from "Firestore is unreachable / threw mid-lookup". The mint endpoint
 * maps these to different HTTP statuses (502 vs 503) so dashboards can
 * tell a not-yet-onboarded user from a chat-proxy ↔ Firestore outage.
 */
type GetMmCredsResult =
  | { ok: true; mmToken: string; mmUserId: string }
  | { ok: false; reason: 'not-provisioned' }
  | { ok: false; reason: 'lookup-error' };

async function getMmCreds(uid: string): Promise<GetMmCredsResult> {
  const cached = mmCredsCache.get(uid);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return { ok: true, mmToken: cached.mmToken, mmUserId: cached.mmUserId };
    }
    // Evict expired so the Map size tracks the active-user set rather than
    // the historical-user set.
    mmCredsCache.delete(uid);
  }

  try {
    const [userDoc, secretDoc] = await Promise.all([
      db.doc(`users/${uid}`).get(),
      db.doc(`users/${uid}/secrets/mattermost`).get(),
    ]);

    const mmUserId = userDoc.data()?.mattermost?.userId;
    const mmToken = secretDoc.data()?.personalToken;

    if (!mmUserId || !mmToken) return { ok: false, reason: 'not-provisioned' };

    mmCredsCache.set(uid, {
      mmToken,
      mmUserId,
      expiresAt: Date.now() + MM_CREDS_CACHE_TTL,
    });

    return { ok: true, mmToken, mmUserId };
  } catch (e: any) {
    console.error(`[proxy] Failed to load MM creds for ${uid}: ${e.message}`);
    return { ok: false, reason: 'lookup-error' };
  }
}

// ── Firebase Auth Verification ────────────────────────────────────────────────

export async function verifyAuth(req: http.IncomingMessage): Promise<string | null> {
  const authHeader = req.headers.authorization;

  // MM Client4 SDK sends "BEARER" (uppercase), standard is "Bearer"
  let token: string | null = null;
  if (authHeader?.startsWith("Bearer ")) token = authHeader.slice(7);
  else if (authHeader?.startsWith("BEARER ")) token = authHeader.slice(7);
  else if (authHeader?.startsWith("Token ")) token = authHeader.slice(6);

  if (!token) return null;

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch (e: any) {
    console.error(`[proxy] auth failed: ${e.code || e.message}`);
    return null;
  }
}

// ── CORS ──────────────────────────────────────────────────────────────────────

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ── HTTP request handler ──────────────────────────────────────────────────────

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/metrics") {
    const metrics = await metricsRegistry.metrics();
    res.writeHead(200, { "Content-Type": metricsRegistry.contentType });
    res.end(metrics);
    return;
  }

  if (req.url === "/healthz" || req.url === "/health" || req.url === "/_health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  const urlPath = (req.url || "").split("?")[0];

  if (urlPath === "/api/auth/mattermost" && req.method === "POST") {
    return handleMattermostMint(req, res);
  }

  // ── Activity Stream approval callback (Phase 1, spec §6) ────────────────────
  // MM Interactive Message buttons POST here when an owner clicks Approve/Deny.
  // The handler verifies HMAC, IP allowlist, owner authorization, then
  // dispatches OC's typed approval RPCs (exec.approval.resolve / plugin.approval.resolve).
  //
  // Route by path first; the handler itself returns 405 for non-POST so GET/etc
  // distinguish "route exists but wrong method" (405) from "no such route" (404).
  // This is what the wiring smoke tests assert.
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

  // Drain any inbound body before responding so a legacy POST (e.g. an old
  // client still calling `/api/v4/posts`) doesn't leave bytes on the socket
  // and break HTTP keep-alive on the next request.
  req.resume();
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

// ── Mattermost credential mint ────────────────────────────────────────────────
//
// POST /api/auth/mattermost
//   Authorization: Bearer <firebase-id-token>
//
// → 200 { mmUrl, mmToken, mmUserId }
//
// SECURITY NOTE: this returns the user's per-user MM PAT to the browser. The
// PAT is per-user-scoped and revocable. The browser holds it in memory only
// (not localStorage). Never log the response body or the mmToken value.

async function handleMattermostMint(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const uid = await verifyAuth(req);
  if (!uid) {
    mintRequestsTotal.inc({ outcome: 'unauthenticated' });
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthenticated" }));
    return;
  }

  const result = await getMmCreds(uid);
  if (!result.ok) {
    if (result.reason === 'lookup-error') {
      // Firestore unreachable / threw mid-read — operator-facing problem,
      // not the user's. 503 so dashboards bucket it under "outage" rather
      // than "user-not-onboarded" (which 502 means below).
      mintRequestsTotal.inc({ outcome: 'lookup-error' });
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Credential lookup unavailable" }));
      return;
    }
    mintRequestsTotal.inc({ outcome: 'not-provisioned' });
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Chat not provisioned" }));
    return;
  }

  mintRequestsTotal.inc({ outcome: 'ok' });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    mmUrl: MM_PUBLIC_URL,
    mmToken: result.mmToken,
    mmUserId: result.mmUserId,
  }));
}

// ── OpenClaw WebSocket Proxy ──────────────────────────────────────────────────
//
// Browser opens `wss://chat-proxy/api/openclaw/ws/<ticket>`; we validate the
// one-time ticket from `ocTickets/{ticket}` (minted by workspace-api after
// Firebase auth), resolve the user's assigned gateway, open an authenticated
// upstream WS via the Ed25519 device handshake, and pipe frames.
// The browser sees a normal WS; it never needs to know about Ed25519
// nonces or the gateway URL.

function handleOpenClawWsUpgrade(
  wss: WebSocketServer,
  req: http.IncomingMessage,
  socket: any,
  head: Buffer,
): void {
  const urlPath = (req.url || "").split("?")[0];
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

      // Atomic claim: read + delete inside a transaction so two concurrent
      // upgrades with the same ticket can't both pass the validation window.
      // One transaction commits the delete; the other sees a missing doc
      // and rejects. Also validates shape (uid type, expiresAt number) inside
      // the transaction so a malformed doc — missing expiresAt yields
      // `undefined < Date.now()` → false → non-expired — is rejected too.
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
      } catch (e: any) {
        if (e?.message === TICKET_INVALID) {
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

      // Derive the expected agentId for this user from the SAME `users/{uid}`
      // doc that resolveGatewayUrl already read — no second Firestore round
      // trip on the WS upgrade path. Used by the per-user frame filter (#728)
      // to scope inbound gateway broadcast events. If the user lacks the
      // fields needed, refuse the upgrade rather than fall back to forwarding
      // everything (fail-closed — see frame-filter.ts).
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

      // Auth token lookup. Missing secret / empty secret / unreachable SM
      // is a 503 (misconfigured deploy) rather than a 502 (bad gateway) —
      // the gateway itself is probably fine; the operator just hasn't
      // wired the secret yet.
      let token: string;
      try {
        token = await fetchGatewayToken({ gatewayId });
      } catch (e) {
        if (e instanceof GatewayTokenError) {
          console.error(`[proxy] OC WS: token fetch failed — ${e.code}: ${e.message}`);
          socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
          socket.destroy();
          return;
        }
        throw e;
      }

      // Handshake. On auth-failed the cached token may have been superseded
      // by a fresh gateway boot — invalidate + retry ONCE with a forced
      // re-fetch. Closes the rotation race without surfacing a stale-token
      // 502 to the user. `upstream` initialized to null so TypeScript's
      // definite-assignment checker catches any future branch that
      // forgets to assign before the `wss.handleUpgrade` call below.
      let upstream: WebSocket | null = null;
      const tryOpen = (authToken: string) =>
        openUpstream({
          url: gatewayUrl,
          token: authToken,
          identity: getOpenClawIdentity(),
        });
      try {
        upstream = await tryOpen(token);
        ocWsHandshakeTotal.inc({ outcome: "ok" });
      } catch (e) {
        const code = e instanceof UpstreamError ? e.code : "unknown";
        if (code === "auth-failed") {
          invalidateGatewayToken(gatewayId);
          // Re-fetch step. A failure here (SM unreachable, permission
          // denied, placeholder still in place) is a token-source
          // problem, not a gateway outage — respond 503 so dashboards
          // bucket it correctly and clients know to retry later.
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
            socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
            socket.destroy();
            return;
          }
          try {
            upstream = await tryOpen(fresh);
            ocWsHandshakeTotal.inc({ outcome: "ok" });
            ocWsRotationRecoveredTotal.inc();
          } catch (retryErr) {
            const retryCode =
              retryErr instanceof UpstreamError ? retryErr.code : "unknown";
            console.log(
              `[proxy] OC WS: upstream handshake failed after rotation retry — ${retryCode}`,
            );
            ocWsHandshakeTotal.inc({ outcome: `fail:${retryCode}` });
            socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            socket.destroy();
            return;
          }
        } else {
          console.log(`[proxy] OC WS: upstream handshake failed — ${code}`);
          ocWsHandshakeTotal.inc({ outcome: `fail:${code}` });
          socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          socket.destroy();
          return;
        }
      }
      if (!upstream) {
        // Unreachable — every path above either assigns or returns. Guard
        // against future refactors that split the try/catch chain without
        // preserving the invariant.
        console.error("[proxy] OC WS: upstream was never assigned — bug");
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (clientWs) => {
        ocWsConnectionsActive.inc();

        clientWs.on("message", (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(isBinary ? data : data.toString(), { binary: isBinary });
          }
        });
        upstream.on("message", (data, isBinary) => {
          if (clientWs.readyState !== WebSocket.OPEN) return;
          // Binary frames bypass the filter — gateway broadcast() carries
          // per-user data only as JSON text. If that ever changes, the
          // filter will need to grow; for now binary forwards as-is.
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
            clientWs.send(text);
          } else {
            // Sample-log dropped frames so we can spot real cross-user fan-out
            // in production without flooding logs. Counter is the canonical
            // signal; the log is for forensic context — at most one line per
            // uid per 60s window.
            const now = Date.now();
            const last = lastFrameDropLogByUid.get(uid) ?? 0;
            if (now - last >= FRAME_DROP_LOG_WINDOW_MS) {
              lastFrameDropLogByUid.set(uid, now);
              console.warn(
                `[proxy] OC WS: dropped frame uid=${uid} reason=${decision.reason}`,
              );
            }
          }
        });
        clientWs.on("close", () => {
          ocWsConnectionsActive.dec();
          try {
            upstream.close();
          } catch {
            // ignore
          }
        });
        upstream.on("close", () => clientWs.close());
        clientWs.on("error", () => {
          try {
            upstream.close();
          } catch {
            // ignore
          }
        });
        upstream.on("error", () => clientWs.close());
      });
    } catch (e: any) {
      console.error(`[proxy] OC WS error: ${e?.message ?? e}`);
      socket.write("HTTP/1.1 500 Internal Error\r\n\r\n");
      socket.destroy();
    }
  })();
}

// ── Test helpers ────────────────────────────────────────────────────────────────

/** Clear in-process credential cache. For test isolation only. */
export function _clearCaches(): void {
  mmCredsCache.clear();
}

// ── Server ────────────────────────────────────────────────────────────────────

export function createServer() {
  const server = http.createServer(handleRequest);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const urlPath = (req.url || "").split("?")[0];
    if (urlPath.startsWith("/api/openclaw/ws/")) {
      handleOpenClawWsUpgrade(wss, req, socket, head);
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });

  return server;
}

if (process.env.NODE_ENV !== "test") {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`[chat-proxy] listening on :${PORT}`);
    console.log(`[chat-proxy] MM public URL: ${MM_PUBLIC_URL}`);
    console.log(`[chat-proxy] Firebase project: ${FIREBASE_PROJECT}`);
  });

  // Phase 0.5: capture OC plugin-load-per-turn baseline. Single scraper
  // hits the colocated gateway's /metrics over loopback every 30s and
  // observes each parsed stage into `ocPluginLookupDurationMs`. The
  // histogram lives on chat-proxy's /metrics so one Prometheus scrape
  // config picks up both surfaces. See docs/ACTIVITY-STREAM-SPEC.md
  // §10 Phase 0.5 + §9.3.
  const gatewayMetricsUrl = process.env.OPENCLAW_GATEWAY_METRICS_URL
    ?? "http://127.0.0.1:18789/metrics";
  startMetricsBaseline({
    fetchGatewayMetrics: async () => {
      const res = await fetch(gatewayMetricsUrl);
      if (!res.ok) {
        throw new Error(`gateway /metrics returned ${res.status}`);
      }
      return res.text();
    },
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

  // ── Activity Stream Phase 1: bridge boot ──────────────────────────────────
  // Singleton bridge — one extra upstream gateway WS per chat-proxy pod that
  // sees ALL `agent` events and posts to MM activity channels. See
  // docs/ACTIVITY-STREAM-SPEC.md §4.1 + §4.2.
  void (async () => {
    const mmAdminPat = process.env.MM_ADMIN_PAT ?? '';
    if (!mmAdminPat || mmAdminPat.trim().length === 0) {
      console.warn(
        '[chat-proxy] MM_ADMIN_PAT not mounted — skipping activity bridge boot. ' +
        'Mount K8s secret `mattermost-gateway/admin_token` to enable. See ' +
        'helm/octogee/charts/gateway/templates/deployment.yaml.',
      );
      return;
    }
    const { wireActivityBridge, connectBridgeUpstream } = await import('./openclaw/bridge-boot.js');
    let wired: Awaited<ReturnType<typeof wireActivityBridge>>;
    try {
      wired = wireActivityBridge({
        // Firebase Admin Firestore satisfies our FirestoreLike interface at
        // runtime; the type-cast bridges the structural-vs-nominal gap (the
        // SDK's QueryDocumentSnapshot.ref.parent.parent CAN be null, but for
        // the doc paths we read it never is).
        db: db as unknown as Parameters<typeof wireActivityBridge>[0]['db'],
        upstreamUrl: process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789',
        gatewayToken: '', // bridge-boot fetches a fresh token via existing chat-proxy path on each upstream connect
        mmAdminPat,
        identity: getOpenClawIdentity(),
        mmBaseUrl: MM_PUBLIC_URL,
        metrics: { ...bridgeMetrics, approvalDropped: approvalDroppedCounter },
        log: (msg) => console.warn(msg),
      });
    } catch (err) {
      console.error(
        `[chat-proxy] activity bridge wire failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    approvalCallbackHandler = wired.approvalCallbackHandler;

    // Open the dedicated upstream WS for the bridge (separate from per-user
    // upstreams in the WS-upgrade flow). The bridge sees every agent event
    // exactly once via this connection.
    try {
      const gatewayId = 'sidecar';
      const tokenResolved = await fetchGatewayToken({ gatewayId });
      const ws = await openUpstream({
        url: process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789',
        token: tokenResolved,
        identity: getOpenClawIdentity(),
      });
      await connectBridgeUpstream(wired, {
        ws,
        log: (msg) => console.warn(msg),
        metrics: bridgeMetrics,
      });
      console.log('[chat-proxy] activity bridge upstream WS connected');

      // Phase 3 runtime: open MM WebSocket for reaction_added + posted events.
      // Routes 🛑 / 🔀 reactions to the reaction-handler (chat.abort) and
      // thread replies on tracked run roots to chat.send {deliver:false}
      // (reply-as-steer, spec §7) — both over the bridge's RPC client.
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
                  .collectionGroup('users' as never)
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
    } catch (err) {
      console.error(
        `[chat-proxy] activity bridge upstream connect failed: ${err instanceof Error ? err.message : String(err)} — bridge will not receive agent events until restart`,
      );
    }
  })();
}
