import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net, { AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import {
  createGatewayRouter,
  gatewaySurfaceTarget,
} from "../public-router";
import {
} from "@octogee/shared/types/gateway-releases";

const servers: http.Server[] = [];

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function closeAll(): Promise<void> {
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
}

function requestText(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("response aborted")));
    });
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  await closeAll();
});

describe("gatewaySurfaceTarget", () => {
  it("maps public api gateway paths to the selected gateway-edge sidecar route", () => {
    expect(gatewaySurfaceTarget({
      host: "api.octogee.com",
      url: "/g/bender-green/byosub/health?probe=1",
      namespace: "octogee",
    })).toEqual({
      gatewayId: "bender-green",
      revision: null,
      surface: "api",
      origin: "http://gateway-edge-bender-green.octogee.svc.cluster.local:3001",
      path: "/api/g/bender-green/byosub/health?probe=1",
    });
  });

  it("preserves the Dashboard launch, asset, and WebSocket route shape on TEST and PROD api origins", () => {
    for (const host of ["api-test.octogee.com", "api.octogee.com"]) {
      for (const suffix of [
        "openclaw/launch/opaque-ticket",
        "openclaw/assets/app.js?build=1",
        "openclaw",
      ]) {
        expect(gatewaySurfaceTarget({
          host,
          url: `/g/bender/${suffix}`,
          namespace: host.startsWith("api-test") ? "octogee-test" : "octogee",
        })).toMatchObject({
          gatewayId: "bender",
          surface: "api",
          path: `/api/g/bender/${suffix}`,
        });
      }
    }
  });

  it("never selects a gateway-local preview origin, even for the preview host", () => {
    expect(gatewaySurfaceTarget({
      host: "preview.octogee.com",
      url: "/g/bender-green/a1b2c3d4e5f6/",
      namespace: "octogee-test",
    })).toEqual({
      gatewayId: "bender-green",
      revision: null,
      surface: "api",
      origin: "http://gateway-edge-bender-green.octogee-test.svc.cluster.local:3001",
      path: "/api/g/bender-green/a1b2c3d4e5f6/",
    });
  });

  it("rejects non-locality paths and malformed gateway ids", () => {
    expect(gatewaySurfaceTarget({ host: "api.octogee.com", url: "/api/workspace/git", namespace: "octogee" })).toBeNull();
    expect(gatewaySurfaceTarget({ host: "api.octogee.com", url: "/g/Bender/byosub/health", namespace: "octogee" })).toBeNull();
    expect(gatewaySurfaceTarget({ host: "preview.octogee.com", url: "/g/../token", namespace: "octogee" })).toBeNull();
    expect(gatewaySurfaceTarget({ host: "api.octogee.com", url: "/g/%ZZ/byosub/health", namespace: "octogee" })).toBeNull();
    expect(gatewaySurfaceTarget({ host: "api.octogee.com", url: "/g/bender/internal/openclaw/agent-control/callback", namespace: "octogee" })).toBeNull();
    expect(gatewaySurfaceTarget({ host: "api.octogee.com", url: "/g/bender/r/3/internal/openclaw/agent-control/callback", namespace: "octogee" })).toBeNull();
    expect(gatewaySurfaceTarget({ host: "api.octogee.com", url: "/g/bender/%69nternal/openclaw/agent-control/callback", namespace: "octogee" })).toBeNull();
    expect(gatewaySurfaceTarget({ host: "api.octogee.com", url: "/g/bender/%2569nternal/openclaw/agent-control/callback", namespace: "octogee" })).toBeNull();
  });

  it("defaults unmatched or missing hosts to the api surface", () => {
    expect(gatewaySurfaceTarget({
      url: "/g/bender/byosub/health",
      namespace: "octogee",
    })?.surface).toBe("api");
    expect(gatewaySurfaceTarget({
      host: "localhost:3001",
      url: "/g/bender/byosub/health",
      namespace: "octogee",
    })?.surface).toBe("api");
  });
});

describe("gatewaySurfaceTarget — revision-pinned address form", () => {
  it("parses /g/<gw>/r/<n>/… as a pinned target addressed at the STABLE service (pinned addressing is retired)", () => {
    expect(gatewaySurfaceTarget({
      host: "api.octogee.com",
      url: "/g/default/r/7/byosub/health?probe=1",
      namespace: "octogee",
    })).toEqual({
      gatewayId: "default",
      revision: 7,
      surface: "api",
      origin: "http://gateway-edge-default.octogee.svc.cluster.local:3001",
      path: "/api/g/default/byosub/health?probe=1",
    });
  });

  it("keeps the service form revision-free (byte-identical to legacy DNS routing)", () => {
    expect(gatewaySurfaceTarget({
      host: "api.octogee.com",
      url: "/g/default/byosub/health",
      namespace: "octogee",
    })).toEqual({
      gatewayId: "default",
      revision: null,
      surface: "api",
      origin: "http://gateway-edge-default.octogee.svc.cluster.local:3001",
      path: "/api/g/default/byosub/health",
    });
  });

  it("reserves the entire /r namespace — any /g/<gw>/r… that is not /r/<posint>/… is invalid", () => {
    // A malformed pinned URL must NEVER fall through to the service-addressed
    // path, or a pinned session would silently follow the live selector to the
    // wrong pod.
    for (const url of [
      "/g/default/r/0/x",
      "/g/default/r/abc/x",
      "/g/default/r/-1/x",
      "/g/default/r",
      "/g/default/r/",
      "/g/default/r/07/x",
    ]) {
      expect(gatewaySurfaceTarget({ host: "api.octogee.com", url, namespace: "octogee" })).toEqual({
        invalidRevision: true,
      });
    }
  });

  it("does NOT reserve segments that merely start with r (only an exact `r` first segment)", () => {
    expect(gatewaySurfaceTarget({
      host: "api.octogee.com",
      url: "/g/default/reports/health",
      namespace: "octogee",
    })).toEqual({
      gatewayId: "default",
      revision: null,
      surface: "api",
      origin: "http://gateway-edge-default.octogee.svc.cluster.local:3001",
      path: "/api/g/default/reports/health",
    });
  });
});

describe("createGatewayRouter — pinned addressing is retired (GATEWAY-SIMPLE-ROLL-SPEC)", () => {
  it("answers every pinned /r/{n} request with the typed revision_gone 404, never dialing upstream", async () => {
    const router = createGatewayRouter({
      namespace: "octogee",
      targetOriginForGateway: () => "http://127.0.0.1:1", // must never be dialed
      log: () => undefined,
    });
    const routerPort = await listen(router);

    const res = await requestText(`http://127.0.0.1:${routerPort}/g/default/r/7/preview/`, {
      host: "api.octogee.com",
    });

    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: "revision_gone",
      gatewayId: "default",
      revision: 7,
      currentRevisionId: null,
    });
  });

  it("service-addressed requests proxy straight through", async () => {
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`ok:${req.url}`);
    });
    const upstreamPort = await listen(upstream);
    const router = createGatewayRouter({
      namespace: "octogee",
      targetOriginForGateway: () => `http://127.0.0.1:${upstreamPort}`,
      log: () => undefined,
    });
    const routerPort = await listen(router);

    const res = await requestText(`http://127.0.0.1:${routerPort}/g/default/byosub/health`, {
      host: "api.octogee.com",
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe("ok:/api/g/default/byosub/health");
  });
});

describe("createGatewayRouter", () => {
  it("rejects a malformed pinned /g/<gw>/r… with 400 (never falls through to the live selector)", async () => {
    const router = createGatewayRouter({
      namespace: "octogee",
      targetOriginForGateway: () => "http://127.0.0.1:1", // must never be dialed
      log: () => undefined,
    });
    const routerPort = await listen(router);

    const res = await requestText(`http://127.0.0.1:${routerPort}/g/default/r`, {
      host: "api.octogee.com",
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_revision" });
  });

  it("proxies api HTTP requests to the selected gateway-edge sidecar with the internal /api/g prefix", async () => {
    const upstreamSeen = vi.fn();
    const upstream = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        upstreamSeen({
          method: req.method,
          url: req.url,
          body,
          header: req.headers["x-router-test"],
        });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const upstreamPort = await listen(upstream);
    const router = createGatewayRouter({
      namespace: "octogee",
      targetOriginForGateway: () => `http://127.0.0.1:${upstreamPort}`,
      log: () => undefined,
    });
    const routerPort = await listen(router);

    const res = await fetch(`http://127.0.0.1:${routerPort}/g/bender-blue/byosub/health`, {
      method: "POST",
      headers: { "host": "api.octogee.com", "x-router-test": "kept" },
      body: "hello",
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(upstreamSeen).toHaveBeenCalledWith({
      method: "POST",
      url: "/api/g/bender-blue/byosub/health",
      body: "hello",
      header: "kept",
    });
  });

  it("never proxies preview-host requests to a gateway-local execution port", async () => {
    const upstreamSeen = vi.fn();
    const upstream = http.createServer((req, res) => {
      upstreamSeen({ method: req.method, url: req.url, host: req.headers.host });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("preview");
    });
    const upstreamPort = await listen(upstream);
    const router = createGatewayRouter({
      namespace: "octogee",
      targetOriginForGateway: () => `http://127.0.0.1:${upstreamPort}`,
      log: () => undefined,
    });
    const routerPort = await listen(router);

    const res = await requestText(`http://127.0.0.1:${routerPort}/g/bender-blue/ticket123/`, {
      host: "preview.octogee.com",
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe("preview");
    expect(upstreamSeen).toHaveBeenCalledWith({
      method: "GET",
      url: "/api/g/bender-blue/ticket123/",
      host: `127.0.0.1:${upstreamPort}`,
    });
  });

  it("proxies WebSocket upgrades to the selected gateway Service", async () => {
    const upstream = http.createServer();
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (ws, req) => {
      ws.send(`path:${req.url}`);
      ws.on("message", (data) => ws.send(data));
    });
    const upstreamPort = await listen(upstream);
    const router = createGatewayRouter({
      namespace: "octogee",
      targetOriginForGateway: () => `http://127.0.0.1:${upstreamPort}`,
      log: () => undefined,
    });
    const routerPort = await listen(router);

    const ws = new WebSocket(`ws://127.0.0.1:${routerPort}/g/bender-blue/mm/websocket`, {
      headers: { host: "api.octogee.com" },
    });
    const messages: string[] = [];
    ws.on("message", (data) => {
      messages.push(String(data));
      if (messages.length === 1) ws.send("ping");
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out with ${messages.join(",")}`)), 2_000);
      ws.on("message", () => {
        if (messages.length === 2) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
    });

    expect(messages).toEqual(["path:/api/g/bender-blue/mm/websocket", "ping"]);
  });

  it("returns 404 for malformed gateway ids without throwing on HTTP or WS requests", async () => {
    const router = createGatewayRouter({
      namespace: "octogee",
      log: () => undefined,
    });
    const routerPort = await listen(router);

    const res = await requestText(`http://127.0.0.1:${routerPort}/g/%ZZ/byosub/health`, {
      host: "api.octogee.com",
    });
    expect(res.status).toBe(404);

    const ws = new WebSocket(`ws://127.0.0.1:${routerPort}/g/%ZZ/mm/websocket`, {
      headers: { host: "api.octogee.com" },
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for malformed WS close")), 2_000);
      ws.on("unexpected-response", (_req, incoming) => {
        clearTimeout(timer);
        expect(incoming.statusCode).toBe(404);
        resolve();
      });
      ws.on("open", () => reject(new Error("malformed WS path unexpectedly opened")));
      ws.on("error", reject);
    });
  });

  it("boots without a preview host because the router has no preview surface", () => {
    expect(() => createGatewayRouter({
      namespace: "octogee",
      log: () => undefined,
    })).not.toThrow();
  });
});

describe("createGatewayRouter socket resilience — a proxied socket error must never kill the process", () => {
  interface Harness {
    routerPort: number;
    upstreamSockets: net.Socket[];
    routerClientSockets: Duplex[];
    logged: Array<{ message: string; meta?: Record<string, unknown> }>;
  }

  async function startProxiedPair(upstream: http.Server): Promise<Harness> {
    const upstreamSockets: net.Socket[] = [];
    upstream.on("connection", (s) => upstreamSockets.push(s));
    const upstreamPort = await listen(upstream);
    const logged: Harness["logged"] = [];
    const router = createGatewayRouter({
      namespace: "octogee",
      targetOriginForGateway: () => `http://127.0.0.1:${upstreamPort}`,
      log: (message, meta) => logged.push({ message, meta }),
    });
    const routerClientSockets: Duplex[] = [];
    router.on("upgrade", (_req, socket) => routerClientSockets.push(socket));
    const routerPort = await listen(router);
    return { routerPort, upstreamSockets, routerClientSockets, logged };
  }

  function wsUpstream(): http.Server {
    const upstream = http.createServer();
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (ws) => ws.send("hello"));
    return upstream;
  }

  async function openProxiedWs(routerPort: number): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${routerPort}/g/bender-blue/mm/websocket`, {
      headers: { host: "api.octogee.com" },
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out establishing proxied ws")), 2_000);
      ws.on("message", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("error", reject);
    });
    ws.on("error", () => undefined);
    return ws;
  }

  it("logs + closes the upstream side when the client socket errors mid-WebSocket (the prod read-ETIMEDOUT crash)", async () => {
    const harness = await startProxiedPair(wsUpstream());
    await openProxiedWs(harness.routerPort);
    const upstreamClosed = new Promise<void>((resolve) =>
      harness.upstreamSockets[0].once("close", () => resolve()),
    );

    harness.routerClientSockets[0].destroy(new Error("read ETIMEDOUT"));

    await upstreamClosed;
    expect(
      harness.logged.some(
        (entry) =>
          entry.message.includes("socket error") &&
          entry.meta?.gatewayId === "bender-blue" &&
          String(entry.meta?.error).includes("read ETIMEDOUT"),
      ),
    ).toBe(true);
  });

  it("logs + closes the client side when the upstream resets mid-WebSocket", async () => {
    const harness = await startProxiedPair(wsUpstream());
    const ws = await openProxiedWs(harness.routerPort);
    const clientClosed = new Promise<void>((resolve) => ws.once("close", () => resolve()));

    for (const s of harness.upstreamSockets) s.resetAndDestroy();

    await clientClosed;
    expect(
      harness.logged.some(
        (entry) => entry.message.includes("socket error") && entry.meta?.gatewayId === "bender-blue",
      ),
    ).toBe(true);
  });

  it("aborts the pending upstream upgrade when the client socket dies before the upgrade completes", async () => {
    const heldUpstreamSockets: Duplex[] = [];
    const upstream = http.createServer();
    upstream.on("upgrade", (_req, socket) => {
      socket.on("error", () => undefined);
      socket.on("end", () => socket.destroy());
      socket.resume();
      heldUpstreamSockets.push(socket);
    });
    const harness = await startProxiedPair(upstream);

    const ws = new WebSocket(`ws://127.0.0.1:${harness.routerPort}/g/bender-blue/mm/websocket`, {
      headers: { host: "api.octogee.com" },
    });
    ws.on("error", () => undefined);
    await vi.waitFor(() => {
      expect(heldUpstreamSockets.length).toBe(1);
      expect(harness.routerClientSockets.length).toBe(1);
    });
    const upstreamClosed = new Promise<void>((resolve) =>
      heldUpstreamSockets[0].once("close", () => resolve()),
    );

    harness.routerClientSockets[0].destroy(new Error("read ETIMEDOUT"));

    await upstreamClosed;
  });

  it("survives an upstream reset mid-HTTP-response and keeps serving", async () => {
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      setTimeout(() => req.socket.resetAndDestroy(), 50);
    });
    const harness = await startProxiedPair(upstream);

    await expect(
      requestText(`http://127.0.0.1:${harness.routerPort}/g/bender-blue/byosub/health`, {
        host: "api.octogee.com",
      }),
    ).rejects.toThrow();

    const health = await requestText(`http://127.0.0.1:${harness.routerPort}/health`, {
      host: "api.octogee.com",
    });
    expect(health.status).toBe(200);
  });
});

describe("createGatewayRouter — retired internal routing headers get no special handling", () => {
  it("forwards ordinary custom headers upstream; only hop-by-hop headers are stripped", async () => {
    const upstreamSeen = vi.fn();
    const upstream = http.createServer((req, res) => {
      upstreamSeen({
        kept: req.headers["x-router-test"] ?? null,
        connection: req.headers["proxy-authorization"] ?? null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamPort = await listen(upstream);
    const router = createGatewayRouter({
      namespace: "octogee",
      targetOriginForGateway: () => `http://127.0.0.1:${upstreamPort}`,
      log: () => undefined,
    });
    const routerPort = await listen(router);

    const res = await fetch(`http://127.0.0.1:${routerPort}/g/default/workspace/git/status`, {
      headers: {
        host: "api.octogee.com",
        "x-router-test": "kept",
        "proxy-authorization": "forged",
      },
    });

    expect(res.status).toBe(200);
    expect(upstreamSeen).toHaveBeenCalledWith({ kept: "kept", connection: null });
    router.close();
    upstream.close();
  });
});

describe("createGatewayRouter — a non-101 upstream upgrade response is forwarded (no silent dead air)", () => {
  // The gateway-edge sidecar rejects a disallowed WS upgrade by writing a raw
  // `HTTP/1.1 403 Forbidden` and destroying the socket — NOT a 101. Node
  // surfaces that on the router's proxy request as "response", not "upgrade".
  // If the router only handles "upgrade", the client socket is left hanging in
  // CONNECTING forever: silent dead air that mimics an LB outage. The router
  // must forward the rejection so the client fails fast.
  function rejectingUpstream(rawResponse: string): http.Server {
    const upstream = http.createServer();
    upstream.on("upgrade", (_req, socket) => {
      socket.on("error", () => undefined);
      socket.write(rawResponse);
      socket.destroy();
    });
    return upstream;
  }

  interface ForwardedResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }

  async function expectHandshake(
    upstream: http.Server,
    { timeoutMs = 2_000 }: { timeoutMs?: number } = {},
  ): Promise<ForwardedResponse> {
    const upstreamPort = await listen(upstream);
    const router = createGatewayRouter({
      namespace: "octogee",
      targetOriginForGateway: () => `http://127.0.0.1:${upstreamPort}`,
      log: () => undefined,
    });
    const routerPort = await listen(router);

    const ws = new WebSocket(`ws://127.0.0.1:${routerPort}/g/bender-blue/mm/websocket`, {
      headers: { host: "api.octogee.com" },
    });
    try {
      return await new Promise<ForwardedResponse>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("router hung: upstream rejection was never propagated to the client")),
          timeoutMs,
        );
        ws.on("unexpected-response", (_req, incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk) => {
            body += chunk;
          });
          incoming.on("end", () => {
            clearTimeout(timer);
            resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body });
          });
          incoming.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
        ws.on("open", () => {
          clearTimeout(timer);
          reject(new Error("client unexpectedly upgraded — upstream rejected the handshake"));
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } finally {
      ws.terminate();
    }
  }

  it("forwards the upstream 403 (origin-allowlist reject) to the client instead of hanging", async () => {
    const res = await expectHandshake(rejectingUpstream("HTTP/1.1 403 Forbidden\r\n\r\n"));
    expect(res.status).toBe(403);
  });

  it("forwards a non-101 upstream response with headers and body intact", async () => {
    const body = '{"error":"nope"}';
    const res = await expectHandshake(
      rejectingUpstream(
        `HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`,
      ),
    );
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.body).toBe(body);
  });

  it("strips transfer-encoding from a chunked upstream reply so the dechunked body is well-framed", async () => {
    // Node's client dechunks the upstream body before the router pipes it, so a
    // forwarded `transfer-encoding: chunked` header would leave the client
    // framing raw bytes as chunks. The router must strip it and close-delimit.
    const res = await expectHandshake(
      rejectingUpstream(
        "HTTP/1.1 502 Bad Gateway\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
      ),
    );
    expect(res.status).toBe(502);
    expect(res.headers["transfer-encoding"]).toBeUndefined();
    expect(res.headers.connection).toBe("close");
    expect(res.body).toBe("hello");
  });

  it("forwards a non-101 upstream reply's headers to the public client", async () => {
    const res = await expectHandshake(
      rejectingUpstream(
        "HTTP/1.1 503 Service Unavailable\r\nretry-after: 2\r\ncontent-length: 0\r\n\r\n",
      ),
    );
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("2");
  });
});
