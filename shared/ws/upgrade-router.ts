// One WS-upgrade router for every chat-proxy and gateway-side WS
// surface. Replaces the ad-hoc per-handler boilerplate (parse origin
// → 403/destroy, parse path → 400/destroy, optional key check →
// 401/destroy, finally `wss.handleUpgrade`).
//
// Why DRY this now: at the time of PR-2b there are four WS surfaces
// across the platform (MM bridge, OpenClaw bridge, builder-shell
// bridge, builder-shell gateway server). Three live in chat-proxy;
// one on the gateway. Spec §10 puts the Origin allowlist + max
// frame-size cap + auth-header check at the upgrade boundary — one
// place to land changes (e.g. tightening the allowlist for F&F).
//
// The router uses ONE underlying `WebSocketServer({ noServer: true })`
// per registered route so each surface can have its own
// `maxPayload`. Multiple routes therefore mean multiple WSServers —
// negligible cost given we have ~4 surfaces.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

/** What the upgrade handler receives once the route accepts the
 *  connection. `ticket` is whatever `extractTicket` returned (or
 *  undefined if no extractor was provided). `req` is the original
 *  upgrade request so handlers needing headers/cookies/remoteAddr
 *  have them. */
export interface WsUpgradeContext {
  ws: WebSocket;
  req: IncomingMessage;
  ticket?: string;
}

export type PathMatcher = string | ((pathname: string) => boolean);

export interface WsUpgradeRoute {
  /** Either a literal path or a predicate. First match wins in
   *  add-order. */
  match: PathMatcher;
  /** Optional path-fragment extractor for "/prefix/<id>" style URLs.
   *  Returning `null` causes a 400 close (caller's path-shape
   *  invariant rejected the request). */
  extractTicket?: (pathname: string) => string | null;
  /** Origin enforcement strategy. Three shapes:
   *   - `Set<string>`: literal allowlist; router 403s on miss.
   *   - `(origin?: string) => boolean`: predicate; router 403s on
   *     false. Use this when the allowlist is dynamic (e.g. honors
   *     `OCTOGEE_ALLOWED_WS_ORIGINS` env that can change per pod
   *     restart) — builder-shell uses this so it stays consistent
   *     with MM/OpenClaw's `isAllowedWsOrigin` behavior.
   *   - `"check-in-handler"`: bypass router-level Origin
   *     enforcement; handler does its own (with metrics/logging). */
  allowedOrigins:
    | Set<string>
    | ((origin: string | undefined) => boolean)
    | "check-in-handler";
  /** Optional shared-secret header check (used by the gateway-side
   *  builder-shell server: `x-internal-service-key`). Compared in
   *  constant time. */
  requireHeaderKey?: {
    header: string;
    expected: string;
  };
  /** Per-route inbound frame-size cap (bytes). Defaults to 1 MiB. */
  maxPayloadBytes?: number;
  /** Called after the WS upgrade completes. The handler owns the
   *  `ws` from this call onward — no further router action. */
  onUpgrade: (ctx: WsUpgradeContext) => void;
}

interface CompiledRoute extends WsUpgradeRoute {
  matchesPath: (pathname: string) => boolean;
  wss: WebSocketServer;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1 << 20;

export class WsUpgradeRouter {
  private readonly routes: CompiledRoute[] = [];
  private attached = false;

  add(route: WsUpgradeRoute): this {
    const matchesPath =
      typeof route.match === "string"
        ? (p: string) => p === route.match
        : (route.match as (p: string) => boolean);
    const wss = new WebSocketServer({
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

  /** Try to route this upgrade request. Returns `true` if a route
   *  matched (the socket is now either upgraded or destroyed with a
   *  4xx); `false` if no route matched (caller owns the 404 fallback).
   *  Lets proxy.ts share one `server.on('upgrade')` listener across
   *  inline MM/OpenClaw branches + router-routed surfaces. */
  dispatch(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const pathname = (req.url ?? "").split("?")[0];
    const route = this.routes.find((r) => r.matchesPath(pathname));
    if (!route) return false;
    this.handleRoute(route, req, socket, head);
    return true;
  }

  private handleRoute(route: CompiledRoute, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = (req.url ?? "").split("?")[0];

    if (route.allowedOrigins !== "check-in-handler") {
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      const allowed =
        typeof route.allowedOrigins === "function"
          ? route.allowedOrigins(origin)
          : origin !== undefined && route.allowedOrigins.has(origin);
      if (!allowed) {
        writeStatusAndDestroy(socket, 403, "Forbidden");
        return;
      }
    }

    if (route.requireHeaderKey) {
      const got = req.headers[route.requireHeaderKey.header.toLowerCase()];
      if (typeof got !== "string" || !constantTimeEqual(got, route.requireHeaderKey.expected)) {
        writeStatusAndDestroy(socket, 401, "Unauthorized");
        return;
      }
    }

    let ticket: string | undefined;
    if (route.extractTicket) {
      const t = route.extractTicket(pathname);
      if (t === null) {
        writeStatusAndDestroy(socket, 400, "Bad Request");
        return;
      }
      ticket = t;
    }

    route.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      route.onUpgrade({ ws, req, ticket });
    });
  }
}

function writeStatusAndDestroy(socket: Duplex, code: number, text: string): void {
  socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`);
  socket.destroy();
}

function constantTimeEqual(a: string, b: string): boolean {
  // Loop length depends ONLY on `b` (the constant server-side expected
  // value), never on the attacker-controlled `a`. Length-mismatch
  // returns immediately because a 10 MiB attacker header otherwise
  // dominates the loop and leaks "key prefix is being checked" via
  // timing. Length is not the secret being protected here; `b` is.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
