import http from "node:http";
import https from "node:https";
import { Duplex } from "node:stream";
import { URL } from "node:url";
import { isValidGatewayId } from "@octogee/shared/types/glm";

export type GatewayRouterSurface = "api" | "preview";

export interface GatewaySurfaceTarget {
  gatewayId: string;
  surface: GatewayRouterSurface;
  origin: string;
  path: string;
}

export interface GatewaySurfaceTargetOptions {
  url: string;
  host?: string | null;
  previewHost?: string;
  namespace: string;
  targetOriginForGateway?: (surface: GatewayRouterSurface, gatewayId: string) => string;
}

export interface CreateGatewayRouterOptions {
  namespace: string;
  previewHost?: string;
  targetOriginForGateway?: (surface: GatewayRouterSurface, gatewayId: string) => string;
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

function defaultOrigin(surface: GatewayRouterSurface, gatewayId: string, namespace: string): string {
  if (surface === "preview") {
    return `http://octogee-gateway-${gatewayId}.${namespace}.svc.cluster.local:9080`;
  }
  return `http://gateway-edge-${gatewayId}.${namespace}.svc.cluster.local:3001`;
}

function normalizedHost(host: string | null | undefined): string {
  return (host ?? "").split(":")[0].toLowerCase();
}

function surfaceForHost(host: string | null | undefined, previewHost?: string): GatewayRouterSurface {
  return previewHost && normalizedHost(host) === normalizedHost(previewHost) ? "preview" : "api";
}

function parseGatewayPath(url: string): { gatewayId: string; remainder: string; search: string } | null {
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
  const remainder = parts.length > 3 ? `/${parts.slice(3).join("/")}` : "";
  return { gatewayId, remainder, search: parsed.search };
}

export function gatewaySurfaceTarget(opts: GatewaySurfaceTargetOptions): GatewaySurfaceTarget | null {
  const parsed = parseGatewayPath(opts.url);
  if (!parsed) return null;
  const surface = surfaceForHost(opts.host, opts.previewHost);
  const origin =
    opts.targetOriginForGateway?.(surface, parsed.gatewayId) ??
    defaultOrigin(surface, parsed.gatewayId, opts.namespace);
  const pathPrefix = surface === "api" ? `/api/g/${parsed.gatewayId}` : `/g/${parsed.gatewayId}`;
  return {
    gatewayId: parsed.gatewayId,
    surface,
    origin,
    path: `${pathPrefix}${parsed.remainder}${parsed.search}`,
  };
}

function requestHeaders(req: http.IncomingMessage, origin: URL): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  headers.host = origin.host;
  return headers;
}

function proxyHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: GatewaySurfaceTarget,
  log: CreateGatewayRouterOptions["log"],
): void {
  const origin = new URL(target.origin);
  const proxyReq = (origin.protocol === "https:" ? https : http).request({
    protocol: origin.protocol,
    hostname: origin.hostname,
    port: origin.port,
    method: req.method,
    path: target.path,
    headers: requestHeaders(req, origin),
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
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "gateway upstream unavailable" }));
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

function proxyUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: GatewaySurfaceTarget,
  log: CreateGatewayRouterOptions["log"],
): void {
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
  const proxyReq = http.request({
    protocol: "http:",
    hostname: origin.hostname,
    port: origin.port,
    method: req.method,
    path: target.path,
    headers: {
      ...requestHeaders(req, origin),
      connection: "upgrade",
      upgrade: req.headers.upgrade ?? "websocket",
    },
  });
  socket.on("close", () => proxyReq.destroy());
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    proxySocket.on("error", logSocketError("upstream"));
    proxySocket.on("close", () => socket.destroy());
    socket.on("close", () => proxySocket.destroy());
    socket.write(
      `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n` +
        Object.entries(proxyRes.headers)
          .flatMap(([key, value]) => (Array.isArray(value) ? value.map((v) => [key, v]) : [[key, value]]))
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (proxyHead.length > 0) socket.write(proxyHead);
    if (head.length > 0) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxyReq.on("error", (err) => {
    log("[gateway-router] upstream WebSocket proxy failed", {
      gatewayId: target.gatewayId,
      surface: target.surface,
      error: err instanceof Error ? err.message : String(err),
    });
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
  const server = http.createServer((req, res) => {
    if ((req.url ?? "").split("?")[0] === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "gateway-router" }));
      return;
    }
    const target = gatewaySurfaceTarget({
      url: req.url ?? "/",
      host: req.headers.host,
      previewHost: opts.previewHost,
      namespace: opts.namespace,
      targetOriginForGateway: opts.targetOriginForGateway,
    });
    if (!target) {
      writeNotFound(res);
      return;
    }
    proxyHttp(req, res, target, opts.log);
  });

  server.on("upgrade", (req, socket, head) => {
    const target = gatewaySurfaceTarget({
      url: req.url ?? "/",
      host: req.headers.host,
      previewHost: opts.previewHost,
      namespace: opts.namespace,
      targetOriginForGateway: opts.targetOriginForGateway,
    });
    if (!target) {
      socket.on("error", (err) => {
        opts.log("[gateway-router] websocket reject socket error", { error: err.message });
      });
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    proxyUpgrade(req, socket, head, target, opts.log);
  });

  return server;
}
