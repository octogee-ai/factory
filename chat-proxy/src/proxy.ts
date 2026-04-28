/**
 * Octogee Chat Proxy — Firebase Auth → Mattermost
 *
 * Stateless Cloud Run service that:
 * 1. Validates Firebase Auth tokens on every request
 * 2. Maps Firebase UID → Mattermost personal access token (from Firestore)
 * 3. Proxies whitelisted MM REST endpoints + WebSocket
 * 4. Mattermost stays fully internal (no public exposure)
 *
 * Team model: team-per-workspace (Phase 4+5). Each workspace gets its own
 * MM team (ws-{slug}). The proxy validates that API requests target a team
 * the user belongs to. DM channels (no team) pass through without checks.
 * Team-per-workspace: each user's teamId lives on workspaces/{slug}.mattermost.teamId (v3.1).
 *
 * Endpoints proxied:
 *   GET  /api/v4/users/me/teams/{id}/channels  (list channels — team-scoped, includes private)
 *   POST /api/v4/users/ids                      (profile lookup)
 *   GET  /api/v4/users/{id}                     (single user profile)
 *   GET  /api/v4/users/{id}/image               (profile avatar)
 *   POST /api/v4/users/status/ids               (bulk user status)
 *   GET  /api/v4/channels/{id}/posts            (message history)
 *   POST /api/v4/posts                          (send message)
 *   GET  /api/v4/files/{id}                     (file download)
 *   GET  /api/v4/files/{id}/thumbnail           (file thumbnail)
 *   GET  /api/v4/posts/{id}/files/info          (file metadata)
 *   POST /api/v4/files                          (file upload)
 *   POST /api/v4/reactions                      (add reaction)
 *   DELETE /api/v4/users/{uid}/posts/{id}/reactions/{emoji}  (remove reaction)
 *   GET  /api/v4/posts/{id}/reactions           (list reactions on a post)
 *   POST /api/v4/channels/direct               (create DM channel)
 *   POST /api/v4/users/search                   (user search for DM creation)
 *   GET  /api/v4/channels/{id}/members          (list channel members)
 *   POST /api/v4/channels/{id}/members          (add channel member)
 *   DELETE /api/v4/channels/{id}/members/{uid}  (remove channel member)
 *   PUT  /api/v4/channels/{id}/members/{uid}/notify_props  (notification prefs)
 *   PUT  /api/v4/users/{id}/status              (set own status)
 *   PUT  /api/v4/users/{id}/image               (upload avatar)
 *   PUT  /api/v4/users/{id}/patch               (update profile)
 *   POST /api/v4/opengraph                      (OpenGraph link previews)
 *   WS   /api/v4/websocket                      (real-time events)
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
const MM_INTERNAL_URL = process.env.MM_INTERNAL_URL; // e.g. http://mattermost.octogee.svc.cluster.local:8065
// MM_TEAM_ID removed — legacy shared team, no longer used (team-per-workspace)
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT || "octogee";
const SA_KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.SA_KEY_PATH;

if (!MM_INTERNAL_URL) {
  console.error("FATAL: MM_INTERNAL_URL is required");
  process.exit(1);
}

// ── Prometheus metrics ────────────────────────────────────────────────────────

const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

const wsConnectionsActive = new Gauge({
  name: 'chat_proxy_ws_connections_active',
  help: 'Number of active WebSocket connections',
  registers: [metricsRegistry],
});

const wsMessagesTotal = new Counter({
  name: 'chat_proxy_ws_messages_total',
  help: 'Total WebSocket messages proxied',
  labelNames: ['direction'] as const,
  registers: [metricsRegistry],
});

const httpProxiedTotal = new Counter({
  name: 'chat_proxy_http_requests_total',
  help: 'Total HTTP requests proxied to Mattermost',
  labelNames: ['method', 'status'] as const,
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

// ── Allowed Endpoints (whitelist) ─────────────────────────────────────────────

const ALLOWED_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  // List teams the user belongs to (for multi-team channel fetch)
  { method: "GET", pattern: /^\/api\/v4\/users\/me\/teams$/ },
  // Channel listing per team
  { method: "GET", pattern: /^\/api\/v4\/users\/me\/teams\/[a-z0-9]+\/channels/ },
  // Profile lookup
  { method: "POST", pattern: /^\/api\/v4\/users\/ids$/ },
  // Get single user profile
  { method: "GET", pattern: /^\/api\/v4\/users\/[a-z0-9]+$/ },
  // Profile avatar image
  { method: "GET", pattern: /^\/api\/v4\/users\/[a-z0-9]+\/image$/ },
  // Bulk user status (online/away/offline/dnd)
  { method: "POST", pattern: /^\/api\/v4\/users\/status\/ids$/ },
  // Message history
  { method: "GET", pattern: /^\/api\/v4\/channels\/[a-z0-9]+\/posts/ },
  // Send message
  { method: "POST", pattern: /^\/api\/v4\/posts$/ },
  // File operations
  { method: "GET", pattern: /^\/api\/v4\/files\/[a-z0-9]+(\/(thumbnail|preview))?$/ },
  { method: "GET", pattern: /^\/api\/v4\/posts\/[a-z0-9]+\/files\/info$/ },
  { method: "POST", pattern: /^\/api\/v4\/files$/ },
  // Reactions
  { method: "POST", pattern: /^\/api\/v4\/reactions$/ },
  { method: "DELETE", pattern: /^\/api\/v4\/users\/[a-z0-9]+\/posts\/[a-z0-9]+\/reactions\/[a-z0-9_+-]+$/ },
  { method: "GET", pattern: /^\/api\/v4\/posts\/[a-z0-9]+\/reactions$/ },
  // DM creation + user search
  { method: "POST", pattern: /^\/api\/v4\/channels\/direct$/ },
  { method: "POST", pattern: /^\/api\/v4\/users\/search$/ },
  // Channel member management
  // Querystring is stripped before allowlist check (see handleRest), so these
  // match the path portion only. MM's GET /members supports ?page=N&per_page=M.
  { method: "GET", pattern: /^\/api\/v4\/channels\/[a-z0-9]+\/members$/ },
  { method: "POST", pattern: /^\/api\/v4\/channels\/[a-z0-9]+\/members$/ },
  { method: "DELETE", pattern: /^\/api\/v4\/channels\/[a-z0-9]+\/members\/[a-z0-9]+$/ },
  { method: "PUT", pattern: /^\/api\/v4\/channels\/[a-z0-9]+\/members\/[a-z0-9]+\/notify_props$/ },
  // User profile + status
  { method: "PUT", pattern: /^\/api\/v4\/users\/[a-z0-9]+\/status$/ },
  { method: "PUT", pattern: /^\/api\/v4\/users\/[a-z0-9]+\/image$/ },
  { method: "PUT", pattern: /^\/api\/v4\/users\/[a-z0-9]+\/patch$/ },
  // OpenGraph link previews
  { method: "POST", pattern: /^\/api\/v4\/opengraph$/ },
];

export function isAllowedRoute(method: string, path: string): boolean {
  return ALLOWED_ROUTES.some(
    (r) => r.method === method && r.pattern.test(path)
  );
}

// ── Token Cache ───────────────────────────────────────────────────────────────

interface CachedToken {
  mmToken: string;
  mmUserId: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const ADMIN_CACHE_KEY = "__admin__";

// ── Role Cache ────────────────────────────────────────────────────────────────

interface CachedRole {
  isAdmin: boolean;
  expiresAt: number;
}

const roleCache = new Map<string, CachedRole>();
const ROLE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function isAdminUser(uid: string): Promise<boolean> {
  const cached = roleCache.get(uid);
  if (cached && cached.expiresAt > Date.now()) return cached.isAdmin;

  const doc = await db.doc(`users/${uid}/system/config`).get();
  const isAdmin = doc.data()?.role === "admin";
  roleCache.set(uid, { isAdmin, expiresAt: Date.now() + ROLE_CACHE_TTL });
  return isAdmin;
}

// Team validation removed — MM enforces channel/team membership natively.
// The proxy authenticates, forwards to MM with the user's token, and MM rejects unauthorized access.

async function getMmToken(uid: string): Promise<{ mmToken: string; mmUserId: string } | null> {
  const cached = tokenCache.get(uid);
  if (cached && cached.expiresAt > Date.now()) {
    return { mmToken: cached.mmToken, mmUserId: cached.mmUserId };
  }

  try {
    // Read MM credentials from Firestore
    const [userDoc, secretDoc] = await Promise.all([
      db.doc(`users/${uid}`).get(),
      db.doc(`users/${uid}/secrets/mattermost`).get(),
    ]);

    const userData = userDoc.data();
    const mmUserId = userData?.mattermost?.userId;
    const mmToken = secretDoc.data()?.personalToken;

    if (!mmUserId || !mmToken) return null;

    tokenCache.set(uid, {
      mmToken,
      mmUserId,
      expiresAt: Date.now() + TOKEN_CACHE_TTL,
    });

    return { mmToken, mmUserId };
  } catch (e: any) {
    console.error(`[proxy] Failed to load MM token for ${uid}: ${e.message}`);
    return null;
  }
}

// Admin token — reads from system/mattermostAdmin (platform admin MM user)
async function getAdminMmToken(): Promise<{ mmToken: string; mmUserId: string } | null> {
  const cached = tokenCache.get(ADMIN_CACHE_KEY);
  if (cached && cached.expiresAt > Date.now()) {
    return { mmToken: cached.mmToken, mmUserId: cached.mmUserId };
  }

  try {
    // MM_ADMIN_TOKEN injected as Cloud Run env var from Secret Manager at deploy time.
    // Non-sensitive metadata (userId) still from Firestore.
    const mmToken = process.env.MM_ADMIN_TOKEN || "";

    const adminDoc = await db.doc("system/mattermostAdmin").get();
    const mmUserId = adminDoc.data()?.userId || "";

    if (!mmUserId || !mmToken) {
      console.error(`[proxy] Admin MM credentials missing — mmUserId=${!!mmUserId} mmToken=${!!mmToken}`);
      return null;
    }

    tokenCache.set(ADMIN_CACHE_KEY, {
      mmToken,
      mmUserId,
      expiresAt: Date.now() + TOKEN_CACHE_TTL,
    });

    return { mmToken, mmUserId };
  } catch (e: any) {
    console.error(`[proxy] Failed to load admin MM token: ${e.message}`);
    return null;
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

// ── REST Proxy ────────────────────────────────────────────────────────────────

async function handleRest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  setCors(req, res);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Metrics endpoint
  if (req.url === "/metrics") {
    const metrics = await metricsRegistry.metrics();
    res.writeHead(200, { "Content-Type": metricsRegistry.contentType });
    res.end(metrics);
    return;
  }

  // Health check
  if (req.url === "/healthz" || req.url === "/health" || req.url === "/_health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Auth
  const uid = await verifyAuth(req);
  if (!uid) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthenticated" }));
    return;
  }

  // Route check
  const urlPath = (req.url || "").split("?")[0];
  if (!isAllowedRoute(req.method || "GET", urlPath)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Endpoint not allowed" }));
    return;
  }

  // Admin users: always use the system admin MM token (reads + writes).
  // Regular users always use their personal token.
  const isAdmin = await isAdminUser(uid);

  // Team validation removed — MM enforces channel/team membership natively.
  // The proxy authenticates the user and forwards to MM with their token.
  // MM rejects unauthorized access with 403.
  const creds = isAdmin
    ? await getAdminMmToken()
    : await getMmToken(uid);
  if (!creds) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Chat not provisioned" }));
    return;
  }

  // Proxy to MM
  const proxyUrl = req.url || "";
  const targetUrl = `${MM_INTERNAL_URL}${proxyUrl}`;

  // Fast-path: reject oversized requests before buffering any body data.
  // Only applies when the client sends a Content-Length header.
  const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || DEFAULT_MAX_BODY_BYTES);
  const declaredLength = parseInt(req.headers["content-length"] || "0", 10);
  if (!isNaN(declaredLength) && declaredLength > maxBodyBytes) {
    req.resume(); // drain so the socket stays healthy
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Payload too large" }));
    return;
  }

  try {
    const body = await readBody(req, maxBodyBytes);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${creds.mmToken}`,
    };

    // Forward content-type (important for file uploads)
    const ct = req.headers["content-type"];
    if (ct) headers["Content-Type"] = ct;

    const mmResp = await fetch(targetUrl, {
      method: req.method || "GET",
      headers,
      redirect: "manual", // Don't follow redirects — forward them to the client
      ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
    });

    // Forward redirects (e.g. MM /users/{id}/image → default avatar)
    if (mmResp.status >= 300 && mmResp.status < 400) {
      const location = mmResp.headers.get("location");
      if (location) {
        // If redirect points to internal MM, rewrite to proxy-relative path
        const mmBase = MM_INTERNAL_URL!.replace(/\/$/, "");
        const rewritten = location.startsWith(mmBase)
          ? location.slice(mmBase.length)
          : location;
        res.writeHead(mmResp.status, { Location: rewritten });
      } else {
        res.writeHead(mmResp.status);
      }
      res.end();
      return;
    }

    // Forward response headers
    const respCt = mmResp.headers.get("content-type");
    if (respCt) res.setHeader("Content-Type", respCt);

    // Forward content-disposition for file downloads
    const cd = mmResp.headers.get("content-disposition");
    if (cd) res.setHeader("Content-Disposition", cd);

    res.writeHead(mmResp.status);
    httpProxiedTotal.inc({ method: req.method || "GET", status: String(mmResp.status) });

    if (mmResp.body) {
      const reader = mmResp.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      await pump();
    } else {
      res.end();
    }
  } catch (e: any) {
    console.error(`[proxy] REST error: ${e.message}`);
    if (!res.headersSent) {
      if (e?.message === "Payload too large") {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Upstream error" }));
    } else {
      res.end();
    }
  }
}

export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

export function readBody(
  req: http.IncomingMessage,
  maxBytes = Number(process.env.MAX_BODY_BYTES || DEFAULT_MAX_BODY_BYTES),
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        settled = true;
        reject(new Error("Payload too large"));
        // Drain remaining data without destroying the socket so the 413
        // response can still be sent to the client.
        req.resume();
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => { if (!settled) resolve(Buffer.concat(chunks)); });
    req.on("error", (err) => { if (!settled) { settled = true; reject(err); } });
  });
}

// ── WebSocket Proxy ───────────────────────────────────────────────────────────

function handleWsUpgrade(
  wss: WebSocketServer,
  req: http.IncomingMessage,
  socket: any,
  head: Buffer
): void {
  // Extract ticket from path: /api/v4/websocket/<ticket>
  // Using path segment (not query param) avoids corruption from MM WebSocketClient
  // which appends its own ?connection_id=... params.
  const urlPath = (req.url || "").split("?")[0];
  const pathMatch = urlPath.match(/\/api\/v4\/websocket\/([a-f0-9-]{36})$/);
  const ticket = pathMatch?.[1] || null;

  if (!ticket) {
    console.log(`[proxy] WS: no ticket`);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  (async () => {
    try {
      const ticketRef = db.doc(`wsTickets/${ticket}`);
      const ticketDoc = await ticketRef.get();

      if (!ticketDoc.exists) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const ticketData = ticketDoc.data()!;
      await ticketRef.delete();

      if (ticketData.expiresAt < Date.now()) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const uid = ticketData.uid;
      // Admin tickets use octogee-admin credentials
      const isAdminTicket = ticketData.isAdminTicket === true;
      const creds = isAdminTicket ? await getAdminMmToken() : await getMmToken(uid);
      if (!creds) {
        socket.write("HTTP/1.1 502 Not Provisioned\r\n\r\n");
        socket.destroy();
        return;
      }

      const mmWsUrl = MM_INTERNAL_URL!.replace(/^http/, "ws");
      const mmWs = new WebSocket(`${mmWsUrl}/api/v4/websocket`);

      mmWs.on("open", () => {
        mmWs.send(JSON.stringify({
          seq: 1,
          action: "authentication_challenge",
          data: { token: creds.mmToken },
        }));

        wss.handleUpgrade(req, socket, head, (clientWs) => {
          wsConnectionsActive.inc();
          clientWs.on("message", (data, isBinary) => {
            wsMessagesTotal.inc({ direction: "inbound" });
            if (mmWs.readyState === WebSocket.OPEN) {
              mmWs.send(isBinary ? data : data.toString(), { binary: isBinary });
            }
          });
          mmWs.on("message", (data, isBinary) => {
            wsMessagesTotal.inc({ direction: "outbound" });
            if (clientWs.readyState === WebSocket.OPEN) {
              // MM sends JSON as text frames — ensure we forward as text, not binary
              clientWs.send(isBinary ? data : data.toString(), { binary: isBinary });
            }
          });
          clientWs.on("close", () => { wsConnectionsActive.dec(); mmWs.close(); });
          mmWs.on("close", () => clientWs.close());
          clientWs.on("error", () => mmWs.close());
          mmWs.on("error", () => clientWs.close());
        });
      });

      mmWs.on("error", (err) => {
        console.error(`[proxy] WS MM error: ${err.message}`);
        socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        socket.destroy();
      });
    } catch (e: any) {
      console.error(`[proxy] WS error: ${e.message}`);
      socket.write("HTTP/1.1 500 Internal Error\r\n\r\n");
      socket.destroy();
    }
  })();
}

// ── OpenClaw WebSocket Proxy ──────────────────────────────────────────────────
//
// Parallel path to the MM proxy above. Browser opens
// `wss://chat-proxy/api/openclaw/ws/<ticket>`; we validate the one-time
// ticket from `ocTickets/{ticket}` (minted by workspace-api after Firebase
// auth), resolve the user's assigned gateway, open an authenticated
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

/** Clear in-process token/role caches. For test isolation only. */
export function _clearCaches(): void {
  tokenCache.clear();
  roleCache.clear();
}

// ── Server ────────────────────────────────────────────────────────────────────

export function createServer() {
  const server = http.createServer(handleRest);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const urlPath = (req.url || "").split("?")[0];
    if (urlPath.startsWith("/api/v4/websocket")) {
      handleWsUpgrade(wss, req, socket, head);
    } else if (urlPath.startsWith("/api/openclaw/ws/")) {
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
    console.log(`[chat-proxy] MM backend: ${MM_INTERNAL_URL}`);
    console.log(`[chat-proxy] Firebase project: ${FIREBASE_PROJECT}`);
  });
}
