

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import * as WsPkg from "ws";
import type { WebSocket } from "ws";
import type { WebSocketServer as WebSocketServerType } from "ws";

export interface WsUpgradeContext {
  ws: WebSocket;
  req: IncomingMessage;
  ticket?: string;
}

export type PathMatcher = string | ((pathname: string) => boolean);

export interface WsUpgradeRoute {
  match: PathMatcher;
  extractTicket?: (pathname: string) => string | null;
  allowedOrigins:
    | Set<string>
    | ((origin: string | undefined) => boolean)
    | "check-in-handler";

  requireHeaderKey?: {
    header: string;
    expected: string;
  };
  maxPayloadBytes?: number;
  authorize?: (req: IncomingMessage) => boolean | Promise<boolean>;
  onUpgrade: (ctx: WsUpgradeContext) => void;
}

interface CompiledRoute extends WsUpgradeRoute {
  matchesPath: (pathname: string) => boolean;
  wss: WebSocketServerType;
}

type ExtractedTicket =
  | { accepted: true; ticket?: string }
  | { accepted: false };

const DEFAULT_MAX_PAYLOAD_BYTES = 1 << 20;
type WebSocketServerConstructor = new (
  opts: ConstructorParameters<typeof WebSocketServerType>[0],
) => WebSocketServerType;
const WebSocketServerCtor = (
  WsPkg.WebSocketServer
  ?? (WsPkg as unknown as { Server: WebSocketServerConstructor }).Server
) as WebSocketServerConstructor;

export class WsUpgradeRouter {
  private readonly routes: CompiledRoute[] = [];
  private attached = false;

  add(route: WsUpgradeRoute): this {
    const matchesPath =
      typeof route.match === "string"
        ? (p: string) => p === route.match
        : (route.match as (p: string) => boolean);
    const wss = new WebSocketServerCtor({
      noServer: true,
      maxPayload: route.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    });
    this.routes.push({ ...route, matchesPath, wss });
    return this;
  }

  attach(server: Server): void {
    if (this.attached) {
      throw new Error("WsUpgradeRouter: already attached to a server");
    }
    this.attached = true;
    server.on("upgrade", (req, socket, head) => {
      if (!this.dispatch(req, socket, head)) {
        writeStatusAndDestroy(socket, 404, "Not Found");
      }
    });
  }

  dispatch(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const pathname = (req.url ?? "").split("?")[0];
    const route = this.routes.find((r) => r.matchesPath(pathname));
    if (!route) return false;
    void this.handleRoute(route, req, socket, head).catch((err) => {
      console.error("WsUpgradeRouter route failed", err);
      writeStatusAndDestroy(socket, 503, "Service Unavailable");
    });
    return true;
  }

  private async handleRoute(
    route: CompiledRoute,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const pathname = (req.url ?? "").split("?")[0];
    const extracted = extractRouteTicket(route, pathname);
    if (!extracted.accepted) {
      writeStatusAndDestroy(socket, 400, "Bad Request");
      return;
    }
    if (!routeAllowsOrigin(route, req)) {
      writeStatusAndDestroy(socket, 403, "Forbidden");
      return;
    }
    if (!routeHeaderMatches(route, req)) {
      writeStatusAndDestroy(socket, 401, "Unauthorized");
      return;
    }
    const authorized = route.authorize ? await route.authorize(req) : true;
    if (socket.destroyed) return;
    if (!authorized) {
      writeStatusAndDestroy(socket, 401, "Unauthorized");
      return;
    }

    route.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      route.onUpgrade({ ws, req, ticket: extracted.ticket });
    });
  }
}

function extractRouteTicket(route: CompiledRoute, pathname: string): ExtractedTicket {
  if (!route.extractTicket) return { accepted: true };
  const ticket = route.extractTicket(pathname);
  return ticket === null ? { accepted: false } : { accepted: true, ticket };
}

function routeAllowsOrigin(route: CompiledRoute, req: IncomingMessage): boolean {
  if (route.allowedOrigins === "check-in-handler") return true;
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  return typeof route.allowedOrigins === "function"
    ? route.allowedOrigins(origin)
    : origin !== undefined && route.allowedOrigins.has(origin);
}

function routeHeaderMatches(route: CompiledRoute, req: IncomingMessage): boolean {
  if (!route.requireHeaderKey) return true;
  const got = req.headers[route.requireHeaderKey.header.toLowerCase()];
  return typeof got === "string" && constantTimeEqual(got, route.requireHeaderKey.expected);
}

function writeStatusAndDestroy(socket: Duplex, code: number, text: string): void {
  socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`);
  socket.destroy();
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
