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
 *   GET  /api/v4/channels/{id}/posts            (message history)
 *   POST /api/v4/posts                          (send message)
 *   GET  /api/v4/files/{id}                     (file download)
 *   GET  /api/v4/files/{id}/thumbnail           (file thumbnail)
 *   GET  /api/v4/posts/{id}/files/info          (file metadata)
 *   POST /api/v4/files                          (file upload)
 *   WS   /api/v4/websocket                      (real-time events)
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import admin from "firebase-admin";

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8080", 10);
const MM_INTERNAL_URL = process.env.MM_INTERNAL_URL; // e.g. http://mattermost.octogee-test.svc.cluster.local:8065
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT || "octogee";

if (!MM_INTERNAL_URL) {
  console.error("FATAL: MM_INTERNAL_URL is required");
  process.exit(1);
}

// Initialize Firebase Admin
admin.initializeApp({ projectId: FIREBASE_PROJECT });
const db = admin.firestore();

// ── Allowed Endpoints (whitelist) ─────────────────────────────────────────────

const ALLOWED_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  // Channel listing
  { method: "GET", pattern: /^\/api\/v4\/users\/me\/teams\/[a-z0-9]+\/channels/ },
  // Also allow the variant without team ID (Client4.getMyChannels('') hits this)
  { method: "GET", pattern: /^\/api\/v4\/users\/me\/channels/ },
  // Profile lookup
  { method: "POST", pattern: /^\/api\/v4\/users\/ids$/ },
  // Get single user profile
  { method: "GET", pattern: /^\/api\/v4\/users\/[a-z0-9]+$/ },
  // Message history
  { method: "GET", pattern: /^\/api\/v4\/channels\/[a-z0-9]+\/posts/ },
  // Send message
  { method: "POST", pattern: /^\/api\/v4\/posts$/ },
  // File operations
  { method: "GET", pattern: /^\/api\/v4\/files\/[a-z0-9]+(\/(thumbnail|preview))?$/ },
  { method: "GET", pattern: /^\/api\/v4\/posts\/[a-z0-9]+\/files\/info$/ },
  { method: "POST", pattern: /^\/api\/v4\/files$/ },
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
  if (!authHeader?.startsWith("Bearer ")) return null;

  try {
    const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
    return decoded.uid;
  } catch {
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
    const hasAuthHeader = !!req.headers.authorization;
    console.log(`[proxy] 401: hasAuthHeader=${hasAuthHeader}, url=${req.url}`);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthenticated" }));
    return;
  }

  console.log(`[proxy] Auth OK: uid=${uid}, method=${req.method}, url=${req.url}`);

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

  // Proxy to MM
  const targetUrl = `${MM_INTERNAL_URL}${req.url}`;
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
      ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
    });

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
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Upstream error" }));
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
  // Extract Firebase token from query string (?token=xxx) or Sec-WebSocket-Protocol
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const firebaseToken =
    url.searchParams.get("firebase_token") ||
    req.headers["sec-websocket-protocol"]?.split(",").map((s) => s.trim()).find((s) => s.startsWith("firebase_"))?.slice(9);

  if (!firebaseToken) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  admin
    .auth()
    .verifyIdToken(firebaseToken)
    .then(async (decoded) => {
      const creds = await getMmToken(decoded.uid);
      if (!creds) {
        socket.write("HTTP/1.1 502 Not Provisioned\r\n\r\n");
        socket.destroy();
        return;
      }

      // Connect to MM WebSocket
      const mmWsUrl = MM_INTERNAL_URL!.replace(/^http/, "ws");
      const mmWs = new WebSocket(`${mmWsUrl}/api/v4/websocket`);

      mmWs.on("open", () => {
        // Authenticate with MM
        mmWs.send(
          JSON.stringify({
            seq: 1,
            action: "authentication_challenge",
            data: { token: creds.mmToken },
          })
        );

        // Accept the client connection
        wss.handleUpgrade(req, socket, head, (clientWs) => {
          // Pipe: client ↔ MM
          clientWs.on("message", (data) => {
            if (mmWs.readyState === WebSocket.OPEN) {
              mmWs.send(data);
            }
          });

          mmWs.on("message", (data) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(data);
            }
          });

          clientWs.on("close", () => mmWs.close());
          mmWs.on("close", () => clientWs.close());

          clientWs.on("error", () => mmWs.close());
          mmWs.on("error", () => clientWs.close());
        });
      });

      mmWs.on("error", (err) => {
        console.error(`[proxy] MM WebSocket error: ${err.message}`);
        socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        socket.destroy();
      });
    })
    .catch(() => {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    });
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(handleRest);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const urlPath = (req.url || "").split("?")[0];
  if (urlPath === "/api/v4/websocket") {
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
