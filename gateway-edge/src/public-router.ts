import http from "node:http";
import https from "node:https";
import { Duplex } from "node:stream";
import { URL } from "node:url";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import {
  INTERNAL_ROUTING_HEADERS,
  gatewayEdgeServiceName,
  gatewayPodServiceName,
  revisionIdForRelease,
} from "@octogee/shared/types/gateway-releases";

export type GatewayRouterSurface = "api" | "preview";

export interface GatewaySurfaceTarget {
  gatewayId: string;
  // null for the service-addressed form (`/g/<gw>/…` → per-gateway Service);
  // a positive integer for the revision-pinned form (`/g/<gw>/r/<n>/…`).
  revision: number | null;
  surface: GatewayRouterSurface;
  origin: string;
  path: string;
}

// A `/g/<gw>/r…` that is not a valid `/r/<positive-int>/…`. The entire `r`
// segment namespace is reserved: a malformed pinned URL is a hard 400, never a
// fall-through to the service-addressed path (which would silently follow the
// live selector and send a pinned session to the wrong pod).
export interface InvalidRevisionResolution {
  invalidRevision: true;
}

export type GatewaySurfaceResolution = GatewaySurfaceTarget | InvalidRevisionResolution;

function isInvalidRevision(
  resolution: GatewaySurfaceResolution,
): resolution is InvalidRevisionResolution {
  return "invalidRevision" in resolution;
}

// The gateway-router's ONE state read: whether a pinned revision has retired.
// Returns `tombstoned: true` (+ current-revision pointer) so the router answers
// a retired /r/{n} with a typed revision_gone 404 instead of dialing a dead pod.
export type RevisionTombstoneLookup = (
  gatewayId: string,
  revision: number,
) => Promise<{ tombstoned: boolean; currentRevisionId?: string | null }>;

// Resolve the DNS host id for the surface target: the bare gateway id addresses
// the Cowboy-flipped per-gateway Service; a pinned revision addresses its own.
function serviceIdFor(gatewayId: string, revision: number | null): string {
  return revision === null ? gatewayId : revisionIdForRelease(gatewayId, revision);
}

export interface GatewaySurfaceTargetOptions {
  url: string;
  host?: string | null;
  previewHost?: string;
  namespace: string;
  targetOriginForGateway?: (surface: GatewayRouterSurface, serviceId: string) => string;
}

export interface CreateGatewayRouterOptions {
  namespace: string;
  previewHost?: string;
  targetOriginForGateway?: (surface: GatewayRouterSurface, serviceId: string) => string;
  revisionTombstoneLookup?: RevisionTombstoneLookup;
  // Cache-bypassing tombstone read, used to recover from a pinned upstream proxy
  // FAILURE (a connection-refused to a likely-gone revision) into a controlled
  // revision_gone rather than a bare 502.
  revisionTombstoneRecheck?: RevisionTombstoneLookup;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// The router is THE public trust boundary for /g/* traffic: the intra-family
// loop-guard/epoch headers are internal-only (set by a gateway-edge forwarding
// hop), so any inbound value is forged — strip them on both the HTTP and the
// upgrade path before proxying. A public client can therefore never influence
// the edge's single-hop guard or epoch handling.
const STRIPPED_PUBLIC_HEADERS = new Set<string>([
  ...HOP_BY_HOP_HEADERS,
  ...INTERNAL_ROUTING_HEADERS,
]);

function defaultOrigin(surface: GatewayRouterSurface, serviceId: string, namespace: string): string {
  if (surface === "preview") {
    return `http://${gatewayPodServiceName(serviceId)}.${namespace}.svc.cluster.local:9080`;
  }
  return `http://${gatewayEdgeServiceName(serviceId)}.${namespace}.svc.cluster.local:3001`;
}

function normalizedHost(host: string | null | undefined): string {
  return (host ?? "").split(":")[0].toLowerCase();
}

function surfaceForHost(host: string | null | undefined, previewHost?: string): GatewayRouterSurface {
  return previewHost && normalizedHost(host) === normalizedHost(previewHost) ? "preview" : "api";
}

// A revision segment is `r/<n>` where n is a positive integer with no leading
// zero. Anything else after the gateway id (including a bare `r`) is an ordinary
// service-form remainder, so the pinned form is opt-in and unambiguous.
function parseRevisionSegment(parts: string[]): number | null {
  if (parts[0] !== "r" || parts.length < 2) return null;
  if (!/^[1-9]\d*$/.test(parts[1])) return null;
  return Number(parts[1]);
}

type ParsedGatewayPath =
  | { gatewayId: string; revision: number | null; remainder: string; search: string }
  | InvalidRevisionResolution;

function parseGatewayPath(url: string): ParsedGatewayPath | null {
  const parsed = new URL(url, "https://gateway-router.local");
  const parts = parsed.pathname.split("/");
  if (parts[1] !== "g" || parts.length < 3) return null;
  let gatewayId: string;
  try {
    gatewayId = decodeURIComponent(parts[2]);
  } catch {
    return null;
  }
  if (!isValidGatewayId(gatewayId)) return null;
  const afterGateway = parts.slice(3);
  const revision = parseRevisionSegment(afterGateway);
  // Reserve the entire `r` first-segment namespace: an exact `r` segment that is
  // not a valid `r/<positive-int>/…` is a hard reject (invalidRevision → 400),
  // never a fall-through to the service form. Segments that merely start with r
  // (`reports`) are ordinary service-form remainders.
  if (afterGateway[0] === "r" && revision === null) {
    return { invalidRevision: true };
  }
  const tail = revision === null ? afterGateway : afterGateway.slice(2);
  if (tail.length > 0) {
    if (tail[0].includes("%")) return null;
    let firstSegment: string;
    try {
      firstSegment = decodeURIComponent(tail[0]);
    } catch {
      return null;
    }
    if (firstSegment === "internal") return null;
  }
  const remainder = tail.length > 0 ? `/${tail.join("/")}` : "";
  return { gatewayId, revision, remainder, search: parsed.search };
}

export function gatewaySurfaceTarget(opts: GatewaySurfaceTargetOptions): GatewaySurfaceResolution | null {
  const parsed = parseGatewayPath(opts.url);
  if (!parsed) return null;
  if ("invalidRevision" in parsed) return parsed;
  const surface = surfaceForHost(opts.host, opts.previewHost);
  const serviceId = serviceIdFor(parsed.gatewayId, parsed.revision);
  const origin =
    opts.targetOriginForGateway?.(surface, serviceId) ??
    defaultOrigin(surface, serviceId, opts.namespace);
  // The /r/<n> is a ROUTING directive consumed to select the revision target
  // (origin = the revision's Service); the revision pod is revision-agnostic in
  // its own routing, so it receives the BARE /api/g/<gw>/… (or /g/<gw>/… preview)
  // path its routes actually mount. Stripping /r/<n> here is P0.
  const pathPrefix = surface === "api" ? `/api/g/${parsed.gatewayId}` : `/g/${parsed.gatewayId}`;
  return {
    gatewayId: parsed.gatewayId,
    revision: parsed.revision,
    surface,
    origin,
    path: `${pathPrefix}${parsed.remainder}${parsed.search}`,
  };
}

function requestHeaders(
  req: http.IncomingMessage,
  origin: URL,
  target: GatewaySurfaceTarget,
  previewHost: string,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (STRIPPED_PUBLIC_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  headers.host = target.surface === "preview" ? previewHost : origin.host;
  return headers;
}

// For a pinned request only: re-check the tombstone (cache-bypass) after the
// upstream proxy fails. Resolves to the retired-revision verdict, or null to
// fall back to a plain 502.
type PinnedUpstreamRecovery = () => Promise<{ currentRevisionId: string | null } | null>;

interface GatewayProxyContext {
  target: GatewaySurfaceTarget;
  previewHost: string;
  log: CreateGatewayRouterOptions["log"];
}

function proxyHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: GatewayProxyContext,
  pinnedRecovery?: PinnedUpstreamRecovery,
): void {
  const { target, previewHost, log } = context;
  const origin = new URL(target.origin);
  const proxyReq = (origin.protocol === "https:" ? https : http).request({
    protocol: origin.protocol,
    hostname: origin.hostname,
    port: origin.port,
    method: req.method,
    path: target.path,
    headers: requestHeaders(req, origin, target, previewHost),
  }, (proxyRes) => {
    proxyRes.on("error", (err) => {
      log("[gateway-router] upstream response socket error", {
        gatewayId: target.gatewayId,
        surface: target.surface,
        error: err.message,
      });
      res.destroy();
    });
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  const writeUpstreamUnavailable = (): void => {
    if (res.headersSent) return;
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "gateway upstream unavailable" }));
  };
  proxyReq.on("error", (err) => {
    log("[gateway-router] upstream HTTP proxy failed", {
      gatewayId: target.gatewayId,
      surface: target.surface,
      error: err instanceof Error ? err.message : String(err),
    });
    if (res.headersSent) {
      // Mid-stream failure: the status line is already on the wire, so the only
      // honest signal left is a truncated connection — never a JSON tail glued
      // onto a partial body.
      res.destroy();
      return;
    }
    if (!pinnedRecovery) {
      writeUpstreamUnavailable();
      return;
    }
    // A pinned upstream failure likely means the revision retired between the
    // cached "not tombstoned" verdict and this dial. Re-check (cache-bypass): if
    // it is now tombstoned, answer with the controlled revision_gone; otherwise
    // a plain 502.
    pinnedRecovery()
      .then((gone) => {
        if (res.headersSent) return;
        if (gone) {
          writeRevisionGone(res, target, gone.currentRevisionId);
          return;
        }
        writeUpstreamUnavailable();
      })
      .catch(() => writeUpstreamUnavailable());
  });
  req.on("error", (err) => {
    log("[gateway-router] client request socket error", {
      gatewayId: target.gatewayId,
      surface: target.surface,
      error: err.message,
    });
    proxyReq.destroy();
  });
  res.on("error", (err) => {
    log("[gateway-router] client response socket error", {
      gatewayId: target.gatewayId,
      surface: target.surface,
      error: err.message,
    });
    proxyReq.destroy();
  });
  res.on("close", () => proxyReq.destroy());
  req.pipe(proxyReq);
}

function writeNotFound(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "gateway route not found" }));
}

function writeInvalidRevision(res: http.ServerResponse): void {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "invalid_revision" }));
}

function writeRevisionGone(
  res: http.ServerResponse,
  target: GatewaySurfaceTarget,
  currentRevisionId: string | null,
): void {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: "revision_gone",
      gatewayId: target.gatewayId,
      revision: target.revision,
      currentRevisionId,
    }),
  );
}

// The tombstone is consulted ONLY for a pinned target and ONLY here — the
// service-addressed hot path never reaches this. Returns the retired-revision
// verdict, or null when the request should proxy through.
async function tombstoneVerdict(
  target: GatewaySurfaceTarget,
  lookup: RevisionTombstoneLookup | undefined,
  log: CreateGatewayRouterOptions["log"],
): Promise<{ currentRevisionId: string | null } | null> {
  if (target.revision === null || !lookup) return null;
  try {
    const result = await lookup(target.gatewayId, target.revision);
    if (result.tombstoned) {
      return { currentRevisionId: result.currentRevisionId ?? null };
    }
  } catch (err) {
    // A tombstone read failure must not synthesize a false revision_gone; fall
    // through to proxy and let the revision's own pod answer (or fail) honestly.
    log("[gateway-router] revision tombstone lookup failed", {
      gatewayId: target.gatewayId,
      revision: target.revision,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

// Serialize an upstream reply's status line + headers back onto the raw client
// socket (the upgrade path bypasses ServerResponse). `strip` drops headers by
// lowercased name; `extra` appends forced ones. The trailing ["", ""] yields the
// header/body separator — correct for the empty-header case too.
function serializeResponseHead(
  res: http.IncomingMessage,
  opts: { strip?: ReadonlySet<string>; extra?: Record<string, string> } = {},
): string {
  const headerLines = Object.entries(res.headers)
    .flatMap(([key, value]) => (Array.isArray(value) ? value.map((v) => [key, v]) : [[key, value]]))
    .filter(([key, value]) => value !== undefined && !opts.strip?.has(String(key).toLowerCase()))
    .map(([key, value]) => `${key}: ${value}`);
  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    headerLines.push(`${key}: ${value}`);
  }
  const statusLine = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`;
  return [statusLine, ...headerLines, "", ""].join("\r\n");
}

function proxyUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  context: GatewayProxyContext,
): void {
  const { target, previewHost, log } = context;
  const origin = new URL(target.origin);
  const logSocketError = (side: "client" | "upstream") => (err: Error) => {
    log("[gateway-router] websocket proxy socket error", {
      gatewayId: target.gatewayId,
      surface: target.surface,
      side,
      error: err.message,
    });
  };
  socket.on("error", logSocketError("client"));
  // Once any status line has reached the client, the fallback 502 below must
  // not glue a second response on top — tear down instead.
  let clientResponded = false;
  const proxyReq = http.request({
    protocol: "http:",
    hostname: origin.hostname,
    port: origin.port,
    method: req.method,
    path: target.path,
    headers: {
      ...requestHeaders(req, origin, target, previewHost),
      connection: "upgrade",
      upgrade: req.headers.upgrade ?? "websocket",
    },
  });
  socket.on("close", () => proxyReq.destroy());
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    proxySocket.on("error", logSocketError("upstream"));
    proxySocket.on("close", () => socket.destroy());
    socket.on("close", () => proxySocket.destroy());
    clientResponded = true;
    // A 101 forwards its handshake headers verbatim (Connection: Upgrade,
    // Sec-WebSocket-Accept, …) — do not strip.
    socket.write(serializeResponseHead(proxyRes));
    if (proxyHead.length > 0) socket.write(proxyHead);
    if (head.length > 0) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxyReq.on("response", (proxyRes) => {
    // Node routes a non-101 upstream reply (edge origin-allowlist 403, roster
    // 503, MM 502) to "response", not "upgrade". Forward it — hop-by-hop and
    // internal-routing headers stripped at the public boundary, body close-
    // delimited — or the socket hangs in CONNECTING forever: the silent dead
    // air that mimics an LB outage. `proxyRes` is already dechunked, so its
    // transfer-encoding must not survive onto the client stream.
    if (socket.destroyed) {
      proxyRes.destroy();
      return;
    }
    clientResponded = true;
    proxyRes.on("error", (err) => {
      logSocketError("upstream")(err);
      socket.destroy();
    });
    socket.write(
      serializeResponseHead(proxyRes, {
        strip: STRIPPED_PUBLIC_HEADERS,
        extra: { Connection: "close" },
      }),
    );
    proxyRes.pipe(socket);
  });
  proxyReq.on("error", (err) => {
    log("[gateway-router] upstream WebSocket proxy failed", {
      gatewayId: target.gatewayId,
      surface: target.surface,
      error: err instanceof Error ? err.message : String(err),
    });
    if (clientResponded) {
      socket.destroy();
      return;
    }
    if (!socket.destroyed) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
  });
  proxyReq.end();
}

export function createGatewayRouter(opts: CreateGatewayRouterOptions): http.Server {
  if (!opts.previewHost) {
    throw new Error("gateway-router preview host is required");
  }
  const previewHost = opts.previewHost;
  const server = http.createServer((req, res) => {
    if ((req.url ?? "").split("?")[0] === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "gateway-router" }));
      return;
    }
    const resolved = gatewaySurfaceTarget({
      url: req.url ?? "/",
      host: req.headers.host,
      previewHost: opts.previewHost,
      namespace: opts.namespace,
      targetOriginForGateway: opts.targetOriginForGateway,
    });
    if (!resolved) {
      writeNotFound(res);
      return;
    }
    if (isInvalidRevision(resolved)) {
      writeInvalidRevision(res);
      return;
    }
    const target = resolved;
    tombstoneVerdict(target, opts.revisionTombstoneLookup, opts.log)
      .then((gone) => {
        if (gone) {
          writeRevisionGone(res, target, gone.currentRevisionId);
          return;
        }
        const pinnedRecovery =
          target.revision !== null && opts.revisionTombstoneRecheck
            ? () => tombstoneVerdict(target, opts.revisionTombstoneRecheck, opts.log)
            : undefined;
        proxyHttp(req, res, { target, previewHost, log: opts.log }, pinnedRecovery);
      })
      .catch((err) => {
        opts.log("[gateway-router] request routing failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "gateway routing error" }));
        }
      });
  });

  server.on("upgrade", (req, socket, head) => {
    const resolved = gatewaySurfaceTarget({
      url: req.url ?? "/",
      host: req.headers.host,
      previewHost: opts.previewHost,
      namespace: opts.namespace,
      targetOriginForGateway: opts.targetOriginForGateway,
    });
    if (!resolved) {
      socket.on("error", (err) => {
        opts.log("[gateway-router] websocket reject socket error", { error: err.message });
      });
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (isInvalidRevision(resolved)) {
      socket.on("error", (err) => {
        opts.log("[gateway-router] invalid_revision WS reject socket error", { error: err.message });
      });
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const target = resolved;
    tombstoneVerdict(target, opts.revisionTombstoneLookup, opts.log)
      .then((gone) => {
        if (gone) {
          socket.on("error", (err) => {
            opts.log("[gateway-router] revision_gone WS reject socket error", { error: err.message });
          });
          socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          return;
        }
        proxyUpgrade(req, socket, head, { target, previewHost, log: opts.log });
      })
      .catch((err) => {
        opts.log("[gateway-router] websocket routing failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!socket.destroyed) {
          socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        }
      });
  });

  return server;
}
