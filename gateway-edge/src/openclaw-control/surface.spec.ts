import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { WsUpgradeRouter } from "@octogee/core/ws/upgrade-router";

import {
  attachOpenClawControlWsRoute,
  createOpenClawControlHttpRouter,
  isOpenClawControlWsPath,
  openClawControlUpstreamBase,
  openClawControlUpstreamPath,
} from "./surface.js";
import { OpenClawControlSessionManager } from "./session.js";
import { OPENCLAW_CONTROL_PINNED_ADVERTISED_METHODS } from "./rpc-policy.js";
import { OpenClawControlResourceLimiter } from "./limits.js";

const servers: http.Server[] = [];
const SESSION_ID = "7f9b8a1e-429d-4c43-9e1a-9f3bd49d9a70";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  })));
});

function sessions(now = () => 1_000): OpenClawControlSessionManager {
  return new OpenClawControlSessionManager({ key: Buffer.alloc(32, 1), now });
}

function issue(manager: OpenClawControlSessionManager): string {
  return manager.issue({
    sessionId: SESSION_ID,
    uid: "uid-owner",
    gatewayId: "bender",
    revisionId: "bender-r7",
    absoluteExpiresAt: 3_601_000,
  }).cookie.split(";", 1)[0];
}

function appWith(args: {
  env: NodeJS.ProcessEnv;
  sessions: OpenClawControlSessionManager;
  redeem?: Parameters<typeof createOpenClawControlHttpRouter>[0]["redeem"];
  authorize?: Parameters<typeof createOpenClawControlHttpRouter>[0]["authorize"];
  httpTimeoutMs?: number;
}) {
  const app = express();
  app.use("/api/g/:gatewayId/openclaw", createOpenClawControlHttpRouter({
    ...args,
    authorize: args.authorize ?? (async () => true),
  }));
  return app;
}

function env(port?: number): NodeJS.ProcessEnv {
  return {
    GATEWAY_ID: "bender",
    GATEWAY_REVISION_ID: "bender-r7",
    GATEWAY_CLASS: "operator",
    API_PUBLIC_URL: "https://api.octogee.com",
    OPENCLAW_GATEWAY_URL: `http://127.0.0.1:${port ?? 18789}`,
    OPENCLAW_GATEWAY_TOKEN: "gateway-secret",
    OPENCLAW_DIR: "/home/node/.openclaw",
  };
}

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("OpenClaw Dashboard HTTP surface", () => {
  it("accepts only its exact base path and a loopback HTTP upstream", () => {
    expect(isOpenClawControlWsPath("/openclaw")).toBe(true);
    expect(isOpenClawControlWsPath("/openclaw/ws")).toBe(false);
    expect(isOpenClawControlWsPath("/openclaw-evil/ws")).toBe(false);
    expect(openClawControlUpstreamPath("/openclaw/assets/app.js?build=1", "bender"))
      .toBe("/g/bender/openclaw/assets/app.js?build=1");
    expect(openClawControlUpstreamPath("/api/g/bender/openclaw/", "bender"))
      .toBe("/g/bender/openclaw/");
    for (const unsafe of [
      "/openclaw/../../hooks",
      "/openclaw/%2e%2e/%2e%2e/hooks",
      "/openclaw/%2F..%2Fhooks",
      "/openclaw\\..\\hooks",
      "/openclaw-evil/hooks",
      "/openclaw/ws?token=gateway-secret",
    ]) {
      expect(() => openClawControlUpstreamPath(unsafe, "bender"), unsafe)
        .toThrow(/outside|sensitive/i);
    }
    expect(openClawControlUpstreamBase(env()).href).toBe("http://127.0.0.1:18789/");
    expect(() => openClawControlUpstreamBase({ OPENCLAW_GATEWAY_URL: "https://127.0.0.1" }))
      .toThrow(/HTTP/i);
    expect(() => openClawControlUpstreamBase({ OPENCLAW_GATEWAY_URL: "http://openclaw.example" }))
      .toThrow(/loopback/i);
  });

  it("redeems once into a clean redirect and a secure path-scoped boot-local cookie", async () => {
    const manager = sessions();
    const ticket = "a".repeat(43);
    const redeem = vi.fn(async (input) => ({
      uid: "uid-owner",
      gatewayId: input.gatewayId,
      revisionId: input.revisionId,
      expiresAt: 3_601_000,
    }));
    const response = await request(appWith({ env: env(), sessions: manager, redeem }))
      .get(`/api/g/bender/openclaw/launch/${ticket}`);
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/g/bender/openclaw/");
    expect(response.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]?.[0]).toContain("Secure");
    expect(response.headers["set-cookie"]?.[0]).toContain("SameSite=Strict");
    expect(JSON.stringify(response.headers)).not.toContain(ticket);
    expect(response.text).not.toContain(ticket);
    expect(redeem).toHaveBeenCalledWith(expect.objectContaining({
      ticket,
      gatewayId: "bender",
      revisionId: "bender-r7",
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    }));
  });

  it("proxies authenticated GET/HEAD assets with exact security headers and no browser identity or token", async () => {
    let captured: http.IncomingHttpHeaders = {};
    const upstream = http.createServer((req, res) => {
      captured = req.headers;
      res.setHeader("content-type", "text/javascript");
      res.setHeader("set-cookie", "openclaw=gateway-secret");
      res.setHeader("authorization", "Bearer gateway-secret");
      res.end("native-ui gateway-secret");
    });
    const port = await listen(upstream);
    const manager = sessions();
    const response = await request(appWith({ env: env(port), sessions: manager }))
      .get("/api/g/bender/openclaw/assets/app.js")
      .set("cookie", issue(manager))
      .set("authorization", "Bearer browser-token")
      .set("x-forwarded-for", "forged")
      .set("x-openclaw-token", "browser-token");
    expect(response.status).toBe(200);
    expect(captured.authorization).toBeUndefined();
    expect(captured.cookie).toBeUndefined();
    expect(captured["x-forwarded-for"]).toBeUndefined();
    expect(captured["x-openclaw-token"]).toBeUndefined();
    expect(captured.origin).toBe("https://api.octogee.com");
    expect(captured["accept-encoding"]).toBe("identity");
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self' blob:",
    );
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(JSON.stringify(response.headers)).not.toContain("gateway-secret");
    expect(response.text).not.toContain("gateway-secret");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "rejects authenticated %s before the upstream",
    async (method) => {
      let requests = 0;
      const upstream = http.createServer((_req, res) => {
        requests += 1;
        res.end("unexpected");
      });
      const port = await listen(upstream);
      const manager = sessions();
      const edge = http.createServer(appWith({ env: env(port), sessions: manager }));
      const edgePort = await listen(edge);
      const response = await fetch(
        `http://127.0.0.1:${edgePort}/api/g/bender/openclaw/rpc`,
        { method, headers: { cookie: issue(manager) } },
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(requests).toBe(0);
    },
  );

  it("times out every upstream HTTP request and returns a redacted typed failure", async () => {
    const upstream = http.createServer(() => {});
    const port = await listen(upstream);
    const manager = sessions();
    const response = await request(appWith({
      env: env(port),
      sessions: manager,
      httpTimeoutMs: 20,
    })).get("/api/g/bender/openclaw/assets/app.js").set("cookie", issue(manager));
    expect(response.status).toBe(504);
    expect(response.body).toEqual({ error: "openclaw-timeout", retryable: true });
    expect(JSON.stringify(response.body)).not.toContain("gateway-secret");
  });
});

describe("OpenClaw Dashboard WebSocket surface", () => {
  it("requires the exact Origin, rewrites connect, enforces policy, bounds in-flight work, and scrubs frames/audit", async () => {
    const upstreamFrames: Array<Record<string, unknown>> = [];
    const upstream = http.createServer();
    const upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws, req));
    });
    upstreamWs.on("connection", (ws) => {
      ws.send(JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "native-smoke" },
      }));
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        upstreamFrames.push(frame);
        if (frame.method === "connect") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              auth: { token: "gateway-secret" },
              features: { methods: [...OPENCLAW_CONTROL_PINNED_ADVERTISED_METHODS] },
            },
          }));
        } else if (frame.method === "tools.invoke") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { output: "safe result gateway-secret" },
          }));
        }
      });
    });
    const upstreamPort = await listen(upstream);
    const manager = sessions();
    const edge = http.createServer(appWith({ env: env(upstreamPort), sessions: manager }));
    const router = new WsUpgradeRouter();
    const audit = vi.fn(async () => {});
    attachOpenClawControlWsRoute({
      router,
      env: env(upstreamPort),
      sessions: manager,
      authorize: async () => true,
      loadGatewayToken: async () => "gateway-secret",
      audit,
      resourceLimiter: new OpenClawControlResourceLimiter({ maxSockets: 1, maxInFlight: 1 }),
      rpcTimeoutMs: 100,
    });
    router.attach(edge);
    const edgePort = await listen(edge);

    const rejected = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: { cookie: issue(manager), origin: "https://evil.example" },
    });
    await new Promise<void>((resolve) => rejected.once("error", () => resolve()));

    const browserFrames: Array<Record<string, unknown>> = [];
    const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: {
        cookie: issue(manager),
        origin: "https://api.octogee.com",
        authorization: "Bearer browser-token",
        "x-forwarded-for": "forged",
      },
    });
    await new Promise<void>((resolve, reject) => {
      browser.on("error", reject);
      browser.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        browserFrames.push(frame);
        if (frame.event === "connect.challenge") {
          browser.send(JSON.stringify({
            type: "req",
            id: "connect-native",
            method: "connect",
            params: {
              auth: { token: "browser-token" },
              device: { id: "browser-device" },
            },
          }));
        } else if ((frame.payload as Record<string, unknown> | undefined)?.type === "hello-ok") {
          browser.send(JSON.stringify({
            type: "req",
            id: "safe-tool",
            method: "tools.invoke",
            params: { name: "memory_search", args: { query: "prior decision" } },
          }));
          browser.send(JSON.stringify({
            type: "req",
            id: "blocked-tool",
            method: "tools.invoke",
            params: { name: "web_fetch", args: { url: "http://169.254.169.254" } },
          }));
        } else if (frame.id === "safe-tool") {
          resolve();
        }
      });
    });
    browser.close();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));

    expect(upstreamFrames).toContainEqual(expect.objectContaining({
      method: "connect",
      params: expect.objectContaining({
        client: expect.objectContaining({ id: "gateway-client", mode: "backend" }),
        role: "operator",
        scopes: ["operator.admin"],
        auth: { token: "gateway-secret" },
      }),
    }));
    expect(upstreamFrames.some((frame) => frame.id === "blocked-tool")).toBe(false);
    expect(JSON.stringify(browserFrames)).not.toContain("gateway-secret");
    expect(JSON.stringify(browserFrames)).not.toContain("browser-token");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      category: "tools_invoke",
      event: "rpc_allow",
      outcome: "ok",
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain("memory_search");
    expect(JSON.stringify(audit.mock.calls)).not.toContain("prior decision");
  });

  it("times out every forwarded RPC and releases the shared in-flight slot", async () => {
    const upstream = http.createServer();
    const upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      upstreamWs.handleUpgrade(req, socket, head, (ws) => upstreamWs.emit("connection", ws, req));
    });
    upstreamWs.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.method === "connect") {
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              features: { methods: [...OPENCLAW_CONTROL_PINNED_ADVERTISED_METHODS] },
            },
          }));
        }
      });
    });
    const upstreamPort = await listen(upstream);
    const manager = sessions();
    const edge = http.createServer(appWith({ env: env(upstreamPort), sessions: manager }));
    const router = new WsUpgradeRouter();
    attachOpenClawControlWsRoute({
      router,
      env: env(upstreamPort),
      sessions: manager,
      authorize: async () => true,
      loadGatewayToken: async () => "gateway-secret",
      audit: async () => {},
      resourceLimiter: new OpenClawControlResourceLimiter({ maxSockets: 1, maxInFlight: 1 }),
      rpcTimeoutMs: 20,
    });
    router.attach(edge);
    const edgePort = await listen(edge);
    const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: { cookie: issue(manager), origin: "https://api.octogee.com" },
    });
    const timeoutFrame = await new Promise<Record<string, unknown>>((resolve, reject) => {
      browser.on("error", reject);
      browser.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.event === "connect.challenge") {
          browser.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params: {} }));
        } else if ((frame.payload as Record<string, unknown> | undefined)?.type === "hello-ok") {
          browser.send(JSON.stringify({ type: "req", id: "status-1", method: "status", params: {} }));
        } else if (frame.id === "status-1") {
          resolve(frame);
        }
      });
    });
    expect(timeoutFrame).toMatchObject({
      ok: false,
      error: { code: "UPSTREAM_TIMEOUT" },
    });
    browser.close();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
  });

  it("terminates a still-negotiating upstream on browser disconnect or capability revocation", async () => {
    let heldSocket: Duplex | undefined;
    let acceptSocket!: () => void;
    let closeSocket!: () => void;
    const accepted = new Promise<void>((resolve) => { acceptSocket = resolve; });
    const closed = new Promise<void>((resolve) => { closeSocket = resolve; });
    const upstream = http.createServer();
    upstream.on("upgrade", (_req, socket) => {
      heldSocket = socket;
      socket.once("close", closeSocket);
      socket.once("end", closeSocket);
      acceptSocket();
    });
    const upstreamPort = await listen(upstream);
    const manager = sessions();
    const edge = http.createServer(appWith({ env: env(upstreamPort), sessions: manager }));
    const router = new WsUpgradeRouter();
    let authorizations = 0;
    attachOpenClawControlWsRoute({
      router,
      env: env(upstreamPort),
      sessions: manager,
      authorize: async () => (authorizations += 1) < 3,
      loadGatewayToken: async () => "gateway-secret",
      audit: async () => {},
      authorizationIntervalMs: 10,
    });
    router.attach(edge);
    const edgePort = await listen(edge);
    const browser = new WebSocket(`ws://127.0.0.1:${edgePort}/openclaw`, {
      headers: { cookie: issue(manager), origin: "https://api.octogee.com" },
    });
    await new Promise<void>((resolve, reject) => {
      browser.once("open", resolve);
      browser.once("error", reject);
    });
    await accepted;
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("upstream stayed open")), 500)),
    ]);
    heldSocket?.destroy();
    expect(authorizations).toBeGreaterThanOrEqual(3);
  });
});
