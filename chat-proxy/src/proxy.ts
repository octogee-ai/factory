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
 * Mattermost REST and WebSocket traffic is NOT proxied here any more. mm.octogee.com
 * (Mattermost ingress) is the path for that. See docs/RUNBOOK.md for the
 * Option-C migration notes.
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import admin from "firebase-admin";
import { Registry, collectDefaultMetrics, Counter, Gauge } from "prom-client";
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
// Public-facing URL of the Mattermost ingress (e.g. https://mm.octogee.com).
// Returned to the browser by the credential-mint endpoint so the client can
// hit MM directly. Required.
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
}
