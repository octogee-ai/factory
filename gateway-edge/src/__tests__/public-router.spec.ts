import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net, { AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import {
  createGatewayRouter,
  gatewaySurfaceTarget,
} from "../public-router";

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
      previewHost: "preview.octogee.com",
      url: "/g/bender-green/byosub/health?probe=1",
      namespace: "octogee",
    })).toEqual({
      gatewayId: "bender-green",
      surface: "api",
      origin: "http://gateway-edge-bender-green.octogee.svc.cluster.local:3001",
      path: "/api/g/bender-green/byosub/health?probe=1",
    });
  });

  it("maps public preview gateway paths to the selected gateway preview port", () => {
    expect(gatewaySurfaceTarget({
      host: "preview.octogee.com",
      previewHost: "preview.octogee.com",
      url: "/g/bender-green/a1b2c3d4e5f6/",
      namespace: "octogee-test",
    })).toEqual({
      gatewayId: "bender-green",
      surface: "preview",
      origin: "http://octogee-gateway-bender-green.octogee-test.svc.cluster.local:9080",
      path: "/g/bender-green/a1b2c3d4e5f6/",
    });
  });

  it("rejects non-locality paths and malformed gateway ids", () => {
    expect(gatewaySurfaceTarget({ host: "api.octogee.com", url: "/api/workspace/git", namespace: "octogee" })).toBeNull();
    expect(gatewaySurfaceTarget({ host: "api.octogee.com", url: "/g/Bender/byosub/health", namespace: "octogee" })).toBeNull();
    expect(gatewaySurfaceTarget({ host: "preview.octogee.com", url: "/g/../token", namespace: "octogee" })).toBeNull();
    expect(gatewaySurfaceTarget({ host: "api.octogee.com", url: "/g/%ZZ/byosub/health", namespace: "octogee" })).toBeNull();
  });

  it("defaults unmatched or missing hosts to the api surface", () => {
    expect(gatewaySurfaceTarget({
      url: "/g/bender/byosub/health",
      namespace: "octogee",
    })?.surface).toBe("api");
    expect(gatewaySurfaceTarget({
      host: "localhost:3001",
      previewHost: "preview.octogee.com",
      url: "/g/bender/byosub/health",
      namespace: "octogee",
    })?.surface).toBe("api");
  });
});

describe("createGatewayRouter", () => {
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
      previewHost: "preview.octogee.com",
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

  it("proxies preview HTTP requests to the selected gateway preview port without rewriting the preview path", async () => {
    const upstreamSeen = vi.fn();
    const upstream = http.createServer((req, res) => {
      upstreamSeen({ method: req.method, url: req.url });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("preview");
    });
    const upstreamPort = await listen(upstream);
    const router = createGatewayRouter({
      namespace: "octogee",
      previewHost: "preview.octogee.com",
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
      url: "/g/bender-blue/ticket123/",
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
      previewHost: "preview.octogee.com",
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
      previewHost: "preview.octogee.com",
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

  it("refuses to boot without an explicit preview host", () => {
    expect(() =>
      createGatewayRouter({
        namespace: "octogee",
        previewHost: "",
        log: () => undefined,
      }),
    ).toThrow(/preview host/i);
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
      previewHost: "preview.octogee.com",
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
