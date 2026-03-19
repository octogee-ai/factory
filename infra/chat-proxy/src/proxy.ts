/**
 * Octogee Chat Proxy — Firebase Auth → Mattermost
 *
 * Stateless Cloud Run service that:
 * 1. Validates Firebase Auth tokens on every request
 * 2. Maps Firebase UID → Mattermost personal access token (from Firestore)
 * 3. Proxies whitelisted MM REST endpoints + WebSocket
 * 4. Mattermost stays fully internal (no public exposure)
 *
 * Endpoints proxied:
 *   GET  /api/v4/users/me/teams/{id}/channels  (list channels)
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

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8080", 10);
const MM_INTERNAL_URL = process.env.MM_INTERNAL_URL; // e.g. http://mattermost.octogee-test.svc.cluster.local:8065
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT || "octogee";
const SA_KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.SA_KEY_PATH;

if (!MM_INTERNAL_URL) {
  console.error("FATAL: MM_INTERNAL_URL is required");
  process.exit(1);
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
  // Channel listing (with or without team ID — Client4.getMyChannels('') sends empty team)
  { method: "GET", pattern: /^\/api\/v4\/users\/me\/teams\/[a-z0-9]*\/channels/ },
  { method: "GET", pattern: /^\/api\/v4\/users\/me\/channels/ },
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
  { method: "DELETE", pattern: /^\/api\/v4\/channels\/[a-z0-9]+\/members\/[a-z0-9]+$/ },
  { method: "PUT", pattern: /^\/api\/v4\/channels\/[a-z0-9]+\/members\/[a-z0-9]+\/notify_props$/ },
  // User profile + status
  { method: "PUT", pattern: /^\/api\/v4\/users\/[a-z0-9]+\/status$/ },
  { method: "PUT", pattern: /^\/api\/v4\/users\/[a-z0-9]+\/image$/ },
  { method: "PUT", pattern: /^\/api\/v4\/users\/[a-z0-9]+\/patch$/ },
  // OpenGraph link previews
  { method: "POST", pattern: /^\/api\/v4\/opengraph$/ },
];

function isAllowedRoute(method: string, path: string): boolean {
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

// ── Firebase Auth Verification ────────────────────────────────────────────────

async function verifyAuth(req: http.IncomingMessage): Promise<string | null> {
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

const ALLOWED_ORIGINS = [
  /^https:\/\/octogee(-test)?\.web\.app$/,
  /^https:\/\/octogee(-test)?\.firebaseapp\.com$/,
  /^https:\/\/(www\.)?octogee\.com$/,
  /^http:\/\/localhost:\d+$/,
];

function setCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin as string | undefined;
  if (origin) {
    for (const pattern of ALLOWED_ORIGINS) {
      if (pattern.test(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        break;
      }
    }
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

  // Get MM token
  const creds = await getMmToken(uid);
  if (!creds) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Chat not provisioned" }));
    return;
  }

  // Rewrite double-slash in team channel listing (Client4.getMyChannels('') sends empty team ID)
  let proxyUrl = req.url || "";
  proxyUrl = proxyUrl.replace(/\/teams\/\/channels/, "/channels");

  // Proxy to MM
  const targetUrl = `${MM_INTERNAL_URL}${proxyUrl}`;
  try {
    const body = await readBody(req);
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
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Upstream error" }));
    } else {
      res.end();
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
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
      const creds = await getMmToken(uid);
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
          clientWs.on("message", (data, isBinary) => {
            if (mmWs.readyState === WebSocket.OPEN) {
              mmWs.send(isBinary ? data : data.toString(), { binary: isBinary });
            }
          });
          mmWs.on("message", (data, isBinary) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              // MM sends JSON as text frames — ensure we forward as text, not binary
              clientWs.send(isBinary ? data : data.toString(), { binary: isBinary });
            }
          });
          clientWs.on("close", () => mmWs.close());
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

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(handleRest);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const urlPath = (req.url || "").split("?")[0];
  if (urlPath.startsWith("/api/v4/websocket")) {
    handleWsUpgrade(wss, req, socket, head);
  } else {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[chat-proxy] listening on :${PORT}`);
  console.log(`[chat-proxy] MM backend: ${MM_INTERNAL_URL}`);
  console.log(`[chat-proxy] Firebase project: ${FIREBASE_PROJECT}`);
});
