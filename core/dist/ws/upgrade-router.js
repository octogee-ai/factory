import * as WsPkg from "ws";
const DEFAULT_MAX_PAYLOAD_BYTES = 1 << 20;
const WebSocketServerCtor = (WsPkg.WebSocketServer
    ?? WsPkg.Server);
export class WsUpgradeRouter {
    routes = [];
    attached = false;
    add(route) {
        const matchesPath = typeof route.match === "string"
            ? (p) => p === route.match
            : route.match;
        const wss = new WebSocketServerCtor({
            noServer: true,
            maxPayload: route.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
        });
        this.routes.push({ ...route, matchesPath, wss });
        return this;
    }
    attach(server) {
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
    dispatch(req, socket, head) {
        const pathname = (req.url ?? "").split("?")[0];
        const route = this.routes.find((r) => r.matchesPath(pathname));
        if (!route)
            return false;
        void this.handleRoute(route, req, socket, head).catch((err) => {
            console.error("WsUpgradeRouter route failed", err);
            writeStatusAndDestroy(socket, 503, "Service Unavailable");
        });
        return true;
    }
    async handleRoute(route, req, socket, head) {
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
        if (socket.destroyed)
            return;
        if (!authorized) {
            writeStatusAndDestroy(socket, 401, "Unauthorized");
            return;
        }
        route.wss.handleUpgrade(req, socket, head, (ws) => {
            route.onUpgrade({ ws, req, ticket: extracted.ticket });
        });
    }
}
function extractRouteTicket(route, pathname) {
    if (!route.extractTicket)
        return { accepted: true };
    const ticket = route.extractTicket(pathname);
    return ticket === null ? { accepted: false } : { accepted: true, ticket };
}
function routeAllowsOrigin(route, req) {
    if (route.allowedOrigins === "check-in-handler")
        return true;
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    return typeof route.allowedOrigins === "function"
        ? route.allowedOrigins(origin)
        : origin !== undefined && route.allowedOrigins.has(origin);
}
function routeHeaderMatches(route, req) {
    if (!route.requireHeaderKey)
        return true;
    const got = req.headers[route.requireHeaderKey.header.toLowerCase()];
    return typeof got === "string" && constantTimeEqual(got, route.requireHeaderKey.expected);
}
function writeStatusAndDestroy(socket, code, text) {
    socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`);
    socket.destroy();
}
function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < b.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}
