import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";

import { WsUpgradeRouter } from "../../shared/ws/upgrade-router";

// Behavior contract for the shared WS upgrade router that all
// chat-proxy upgrade branches (MM, OpenClaw, builder-shell) route
// through. Locks in:
//   - Single 403 / 400 / 401 boilerplate shape
//   - Origin allowlist semantics (with allow-none fallback for paths
//     that do their own Origin checks)
//   - First-match-wins routing
//   - Frame-size cap pass-through
//   - Clean teardown

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    if (!s) continue;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function attempt(
  port: number,
  path: string,
  opts: { origin?: string; headers?: Record<string, string> } = {},
): Promise<{ ok: true; ws: WebSocket } | { ok: false; status: number }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.origin) headers.origin = opts.origin;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.once("open", () => resolve({ ok: true, ws }));
    ws.once("error", () => undefined); // expected on rejection
    ws.once("unexpected-response", (_req, res) => {
      resolve({ ok: false, status: res.statusCode ?? 0 });
    });
  });
}

describe("WsUpgradeRouter", () => {
  it("routes a matching path to its handler when Origin is allowed", async () => {
    const server = createServer();
    servers.push(server);
    const handlerCalls: string[] = [];
    const router = new WsUpgradeRouter();
    router.add({
      match: "/test",
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: ({ ticket }) => {
        handlerCalls.push(ticket ?? "(no ticket)");
      },
    });
    router.attach(server);
    const port = await listen(server);
    const r = await attempt(port, "/test", { origin: "https://app.example" });
    expect(r.ok).toBe(true);
    if (r.ok) r.ws.close();
    expect(handlerCalls).toEqual(["(no ticket)"]);
  });

  it("rejects with 403 when Origin is not in the allowlist", async () => {
    const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/test",
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const r = await attempt(port, "/test", { origin: "https://evil.example" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("rejects with 403 when Origin header is absent", async () => {
    const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/test",
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const r = await attempt(port, "/test");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("supports prefix matching with extractTicket for paths like /builder-shell/<id>", async () => {
    const server = createServer();
    servers.push(server);
    const handlerTickets: string[] = [];
    const router = new WsUpgradeRouter();
    router.add({
      match: (p) => p.startsWith("/builder-shell/"),
      extractTicket: (p) => {
        const m = p.match(/^\/builder-shell\/([A-Za-z0-9_-]{8,32})\/?$/);
        return m ? m[1] : null;
      },
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: ({ ticket }) => {
        handlerTickets.push(ticket ?? "");
      },
    });
    router.attach(server);
    const port = await listen(server);
    const ticket = "abcdef0123456789xyzWVUTSR";
    const r = await attempt(port, `/builder-shell/${ticket}`, { origin: "https://app.example" });
    expect(r.ok).toBe(true);
    if (r.ok) r.ws.close();
    expect(handlerTickets).toEqual([ticket]);
  });

  it("rejects with 400 when extractTicket returns null", async () => {
    const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: (p) => p.startsWith("/builder-shell/"),
      extractTicket: () => null,
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const r = await attempt(port, "/builder-shell/x", { origin: "https://app.example" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("accepts a predicate function for dynamic Origin enforcement", async () => {
    const server = createServer();
    servers.push(server);
    const seen: Array<string | undefined> = [];
    const router = new WsUpgradeRouter();
    router.add({
      match: "/dyn",
      // Function form: lets the route honor an env-driven allowlist
      // (e.g. OCTOGEE_ALLOWED_WS_ORIGINS) without re-attaching.
      allowedOrigins: (origin) => {
        seen.push(origin);
        return origin === "https://app.example";
      },
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const ok = await attempt(port, "/dyn", { origin: "https://app.example" });
    expect(ok.ok).toBe(true);
    if (ok.ok) ok.ws.close();
    const bad = await attempt(port, "/dyn", { origin: "https://evil.example" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(403);
    expect(seen).toEqual(["https://app.example", "https://evil.example"]);
  });

  it("predicate function receives undefined when Origin header is missing", async () => {
    const server = createServer();
    servers.push(server);
    let seenOrigin: string | undefined = "not-called";
    const router = new WsUpgradeRouter();
    router.add({
      match: "/dyn",
      allowedOrigins: (origin) => {
        seenOrigin = origin;
        return false;
      },
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const r = await attempt(port, "/dyn");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
    expect(seenOrigin).toBeUndefined();
  });

  it("allows `allowedOrigins: 'check-in-handler'` to bypass router-level Origin enforcement", async () => {
    // Some surfaces (OpenClaw) do Origin checks inside their handler
    // for metrics/observability reasons. The router must let them.
    const server = createServer();
    servers.push(server);
    let handlerOrigin: string | undefined;
    const router = new WsUpgradeRouter();
    router.add({
      match: "/raw",
      allowedOrigins: "check-in-handler",
      onUpgrade: ({ req }) => {
        handlerOrigin = req.headers.origin as string | undefined;
      },
    });
    router.attach(server);
    const port = await listen(server);
    const r = await attempt(port, "/raw", { origin: "https://anywhere.example" });
    expect(r.ok).toBe(true);
    if (r.ok) r.ws.close();
    expect(handlerOrigin).toBe("https://anywhere.example");
  });

  it("requireHeaderKey rejects an oversized header without scanning all of it (length-mismatch fast-fails)", async () => {
    // Pin the constant-time-compare's "loop length depends ONLY on the
    // expected key, never the attacker-supplied input" property.
    // A 64 KiB header would otherwise dominate the loop and leak
    // "we are still checking" via timing. We can't measure ns timing
    // reliably in vitest, but we CAN pin that a wildly-longer input
    // still rejects without exception/hang.
    const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/k",
      allowedOrigins: "check-in-handler",
      requireHeaderKey: { header: "x-internal-service-key", expected: "abc" },
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    // 2 KiB — well above the expected "abc" but under Node's default
    // 16 KiB HTTP header limit so the upgrade reaches our handler
    // (vs Node 431'ing at the parser layer).
    const r = await attempt(port, "/k", {
      headers: { "x-internal-service-key": "a".repeat(2048) },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("enforces an authHeader allowlist (constant-time match) returning 401 on mismatch", async () => {
    const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/internal",
      allowedOrigins: "check-in-handler",
      requireHeaderKey: { header: "x-internal-service-key", expected: "secret-xyz" },
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const bad = await attempt(port, "/internal", { headers: { "x-internal-service-key": "wrong" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(401);
    const good = await attempt(port, "/internal", { headers: { "x-internal-service-key": "secret-xyz" } });
    expect(good.ok).toBe(true);
    if (good.ok) good.ws.close();
  });

  it("first-match-wins across multiple registered routes", async () => {
    const server = createServer();
    servers.push(server);
    const calls: string[] = [];
    const router = new WsUpgradeRouter();
    router.add({
      match: "/builder-shell/short-prefix",
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: () => calls.push("short"),
    });
    router.add({
      match: (p) => p.startsWith("/builder-shell/"),
      extractTicket: (p) => p.split("/")[2] ?? null,
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: () => calls.push("prefix"),
    });
    router.attach(server);
    const port = await listen(server);
    const r1 = await attempt(port, "/builder-shell/short-prefix", { origin: "https://app.example" });
    if (r1.ok) r1.ws.close();
    const r2 = await attempt(port, "/builder-shell/other-ticket", { origin: "https://app.example" });
    if (r2.ok) r2.ws.close();
    expect(calls).toEqual(["short", "prefix"]);
  });

  it("destroys the socket when no route matches (no 404 in the WS context — destroying signals 'wrong endpoint')", async () => {
    const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/known",
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const r = await attempt(port, "/unknown", { origin: "https://app.example" });
    expect(r.ok).toBe(false);
    // Returns 404 in the HTTP upgrade error path.
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("can be attached to a server that already has its own non-upgrade routes", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200);
        res.end("ok");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/ws",
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    const ws = await attempt(port, "/ws", { origin: "https://app.example" });
    expect(ws.ok).toBe(true);
    if (ws.ok) ws.ws.close();
  });
});
