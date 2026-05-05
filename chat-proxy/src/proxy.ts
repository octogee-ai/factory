import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import admin from "firebase-admin";
import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from "prom-client";
import { startMetricsBaseline } from "./openclaw/metrics-baseline.js";
import { generateIdentity, type DeviceIdentity } from "./openclaw/device-identity.js";
import { openUpstream, UpstreamError } from "./openclaw/upstream.js";
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

const PORT = parseInt(process.env.PORT || "8080", 10);
const MM_PUBLIC_URL = process.env.MM_PUBLIC_URL;
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT || "octogee";
const SA_KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.SA_KEY_PATH;

if (!MM_PUBLIC_URL) {
  console.error("FATAL: MM_PUBLIC_URL is required");
  process.exit(1);
}

const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

const mintRequestsTotal = new Counter({
  name: 'chat_proxy_mint_requests_total',
  help: 'Mattermost credential-mint requests',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});

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
};

const approvalDroppedCounter = new Counter({
  name: 'octogee_bridge_approval_dropped_total',
  help: 'Approval callback drops with reason',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

let approvalCallbackHandler:
  | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>)
  | null = null;

const FRAME_DROP_LOG_WINDOW_MS = 60_000;
const lastFrameDropLogByUid = new Map<string, number>();
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

interface CachedMmCreds {
  mmToken: string;
  mmUserId: string;
  expiresAt: number;
}

const mmCredsCache = new Map<string, CachedMmCreds>();
const MM_CREDS_CACHE_TTL = 5 * 60 * 1000;

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
  } catch (e: any) {
    console.error(`[proxy] auth failed: ${e.code || e.message}`);
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
}

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
        console.error("[proxy] OC WS: upstream was never assigned — bug");
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
        return;
      }

      const gateState = createGateState(expectedAgentId);

      wss.handleUpgrade(req, socket, head, (clientWs) => {
        ocWsConnectionsActive.inc();

        // Watch for gatewayId migration mid-session. The WS upstream URL
        // is captured at upgrade time (above); without this watcher, a
        // customer migrated A→B keeps talking to A until the WS naturally
        // dies. On change, close the client WS (1001 = going away) so the
        // browser reconnects and re-resolves to the new gateway.
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
    } catch (e: any) {
      console.error(`[proxy] OC WS error: ${e?.message ?? e}`);
      socket.write("HTTP/1.1 500 Internal Error\r\n\r\n");
      socket.destroy();
    }
  })();
}

export function _clearCaches(): void {
  mmCredsCache.clear();
}

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

/**
 * Build a Gitea-backed EditDiffFetcher for Phase 4.5 per-edit thread replies
 * (spec docs/ACTIVITY-STREAM-SPEC.md §10). Returns `undefined` when the
 * required env (GITEA_TOKEN, GITEA_URL or K8S_NAMESPACE) is unset — the
 * bridge falls back to nullEditDiffFetcher and posts placeholder bodies.
 *
 * URL convention mirrors workspace-api/src/lib/gitea.ts so the same K8s
 * Service + Secret can serve both surfaces.
 */
async function buildEditDiffFetcher() {
  const giteaToken = process.env.GITEA_TOKEN;
  if (!giteaToken || giteaToken.trim().length === 0) {
    console.warn(
      '[chat-proxy] GITEA_TOKEN not set — Phase 4.5 edit diffs will render as placeholders. ' +
      'Mount K8s secret `gitea-token/token` on chat-proxy to enable.',
    );
    return undefined;
  }
  const ns = process.env.K8S_NAMESPACE || 'octogee';
  // Derive in-cluster Gitea URL from the namespace only — matches
  // workspace-api/src/lib/gitea.ts. We deliberately do NOT honor a
  // GITEA_URL override here: a misconfigured override would be silently
  // rejected by the SSRF guard (or worse, send the PAT to the wrong
  // host), and a single derivation point keeps both surfaces in sync.
  const giteaUrl = `http://octogee-gitea-http.${ns}.svc.cluster.local:3000`;
  const giteaOrg = process.env.GITEA_ORG || 'octogee';
  const giteaPublicBaseUrl = process.env.GITEA_PUBLIC_BASE_URL || undefined;
  const { createGiteaEditDiffFetcher } = await import('./openclaw/gitea-edit-diff-fetcher.js');
  return createGiteaEditDiffFetcher({
    giteaUrl,
    giteaToken,
    giteaOrg,
    giteaPublicBaseUrl,
    log: (msg) => console.warn(msg),
  });
}

if (process.env.NODE_ENV !== "test") {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`[chat-proxy] listening on :${PORT}`);
    console.log(`[chat-proxy] MM public URL: ${MM_PUBLIC_URL}`);
    console.log(`[chat-proxy] Firebase project: ${FIREBASE_PROJECT}`);
  });

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
        db: db as unknown as Parameters<typeof wireActivityBridge>[0]['db'],
        upstreamUrl: process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789',
        gatewayToken: '',
        mmAdminPat,
        identity: getOpenClawIdentity(),
        mmBaseUrl: MM_PUBLIC_URL,
        metrics: { ...bridgeMetrics, approvalDropped: approvalDroppedCounter },
        log: (msg) => console.warn(msg),
        editDiffFetcher: await buildEditDiffFetcher(),
      });
    } catch (err) {
      console.error(
        `[chat-proxy] activity bridge wire failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    approvalCallbackHandler = wired.approvalCallbackHandler;

    const gatewayIdResult = resolveBridgeGatewayId(process.env);
    if (!gatewayIdResult.ok) {
      console.error(
        `[chat-proxy] activity bridge boot aborted — ${gatewayIdResult.reason}. ` +
        'Set GATEWAY_ID env var on the chat-proxy sidecar (helm chart values.env.gatewayId). ' +
        'See docs/ACTIVITY-STREAM-SPEC.md §15.1.',
      );
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

    startBridgeUpstreamReconnectLoop({
      openOnce: async () => {
        const tokenResolved = await fetchGatewayToken({ gatewayId });
        const ws = await openUpstream({
          url: process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789',
          token: tokenResolved,
          identity: getOpenClawIdentity(),
        });
        let closed = false;
        let registered: (() => void) | null = null;
        ws.on('close', () => {
          closed = true;
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
      onConnected: () => console.log('[chat-proxy] activity bridge upstream WS connected'),
    });
  })();
}
