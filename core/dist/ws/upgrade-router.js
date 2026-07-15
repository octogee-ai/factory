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
        let ticket;
        if (route.extractTicket) {
            const extracted = route.extractTicket(pathname);
            if (extracted === null) {
                writeStatusAndDestroy(socket, 400, "Bad Request");
                return;
            }
            ticket = extracted;
        }
        if (route.allowedOrigins !== "check-in-handler") {
            const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
            const allowed = typeof route.allowedOrigins === "function"
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
        if (route.authorize) {
            const allowed = await route.authorize(req);
            if (socket.destroyed)
                return;
            if (!allowed) {
                writeStatusAndDestroy(socket, 401, "Unauthorized");
                return;
            }
        }
        if (socket.destroyed)
            return;
        route.wss.handleUpgrade(req, socket, head, (ws) => {
            route.onUpgrade({ ws, req, ticket });
        });
    }
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
