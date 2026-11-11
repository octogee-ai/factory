import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createVmSessionsRouter, type VmSessionsDeps } from "./vm-sessions.js";
import type { NativeAdminAccessOutcome } from "../lib/native-admin-access.js";
import type { CdpCookie } from "../lib/cdp-cookies.js";

const ALLOWED: NativeAdminAccessOutcome = { kind: "allowed", gatewayId: "gw-alice", workspaceSlug: "alice", canControl: true };

function cookie(overrides: Partial<CdpCookie> & { domain: string; name: string }) {
  return { value: "v", path: "/", secure: true, httpOnly: false, ...overrides };
}

function appForTest(options: {
  available?: boolean;
  resolveAccess?: VmSessionsDeps["resolveAccess"];
  applyCookies?: VmSessionsDeps["applyCookies"];
  uid?: string | null;
} = {}) {
  const applyCookies = vi.fn(options.applyCookies ?? (async (cookies: CdpCookie[]) => ({ stored: cookies.length, dropped: [] })));
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req, _res, next) => {
    if (options.uid !== null) req.uid = options.uid ?? "builder-uid";
    next();
  });
  app.use("/api/g/:gatewayId/computer", createVmSessionsRouter({
    localGatewayId: () => "gw-alice",
    available: options.available ?? true,
    resolveAccess: options.resolveAccess ?? (async () => ALLOWED),
    applyCookies,
    log: () => {},
  }));
  return { app, applyCookies };
}

const importPath = "/api/g/gw-alice/computer/sessions/import";

describe("VM sessions import route", () => {
  it("applies listed cookies via CDP and reports applied and rejected", async () => {
    const { app, applyCookies } = appForTest();
    const res = await request(app).post(importPath).send({
      domains: ["example.com"],
      cookies: [
        cookie({ domain: "www.example.com", name: "a", expires: 1_900_000_000, sameSite: "Lax" }),
        cookie({ domain: "other.test", name: "b" }),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(1);
    expect(res.body.rejected).toEqual([{ name: "b", domain: "other.test", reason: "unlisted_domain" }]);
    expect(applyCookies).toHaveBeenCalledWith([
      { name: "a", value: "v", domain: "www.example.com", path: "/", secure: true, httpOnly: false, expires: 1_900_000_000, sameSite: "Lax" },
    ]);
  });

  it("round-trips a cookie's CHIPS partition key into the CDP call", async () => {
    const { app, applyCookies } = appForTest();
    const res = await request(app).post(importPath).send({
      domains: ["example.com"],
      cookies: [cookie({ domain: "ads.example.com", name: "p", partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: true } })],
    });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(1);
    expect(applyCookies).toHaveBeenCalledWith([
      expect.objectContaining({ name: "p", partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: true } }),
    ]);
  });

  it("omits partitionKey for an unpartitioned cookie", async () => {
    const { app, applyCookies } = appForTest();
    await request(app).post(importPath).send({ domains: ["example.com"], cookies: [cookie({ domain: "example.com", name: "u" })] });
    expect(applyCookies.mock.calls[0]![0][0]).not.toHaveProperty("partitionKey");
  });

  it("rejects a malformed partition topLevelSite and refuses the platform's own origin there", async () => {
    const { app } = appForTest();
    const malformed = await request(app).post(importPath).send({
      domains: ["example.com"],
      cookies: [cookie({ domain: "example.com", name: "p", partitionKey: { topLevelSite: "not-a-url", hasCrossSiteAncestor: true } })],
    });
    expect(malformed.body.rejected[0]).toMatchObject({ name: "p", reason: "invalid_fields" });

    const forbidden = await request(app).post(importPath).send({
      domains: ["example.com"],
      cookies: [cookie({ domain: "example.com", name: "p", partitionKey: { topLevelSite: "https://app.octogee.com", hasCrossSiteAncestor: true } })],
    });
    expect(forbidden.body.rejected[0]).toMatchObject({ name: "p", reason: "forbidden_origin" });
  });

  it("round-trips a cookie's source scheme and port into the CDP call", async () => {
    const { app, applyCookies } = appForTest();
    const res = await request(app).post(importPath).send({
      domains: ["example.com"],
      cookies: [
        cookie({ domain: "example.com", name: "s", sourceScheme: "Secure", sourcePort: 443 }),
        cookie({ domain: "example.com", name: "u", sourceScheme: "Unset", sourcePort: -1 }),
        cookie({ domain: "example.com", name: "n" }),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(3);
    const applied = applyCookies.mock.calls[0]![0];
    expect(applied[0]).toMatchObject({ name: "s", sourceScheme: "Secure", sourcePort: 443 });
    expect(applied[1]).toMatchObject({ name: "u", sourceScheme: "Unset", sourcePort: -1 });
    expect(applied[2]).not.toHaveProperty("sourceScheme");
    expect(applied[2]).not.toHaveProperty("sourcePort");
  });

  it.each([
    { sourceScheme: "https" },
    { sourceScheme: 2 },
    { sourcePort: 0 },
    { sourcePort: 65_536 },
    { sourcePort: -2 },
    { sourcePort: 443.5 },
    { sourcePort: "443" },
  ])("rejects a malformed source field %o as invalid_fields", async (field) => {
    const { app, applyCookies } = appForTest();
    const res = await request(app).post(importPath).send({
      domains: ["example.com"],
      cookies: [{ ...cookie({ domain: "example.com", name: "bad" }), ...field }],
    });
    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([{ name: "bad", domain: "example.com", reason: "invalid_fields" }]);
    expect(applyCookies).toHaveBeenCalledWith([]);
  });

  it("refuses the platform's own origins at the domain and cookie level", async () => {
    const { app, applyCookies } = appForTest();
    const domainRes = await request(app).post(importPath).send({ domains: ["octogee.com"], cookies: [cookie({ domain: "app.octogee.com", name: "x" })] });
    expect(domainRes.status).toBe(400);
    expect(domainRes.body.error).toBe("forbidden_domain");

    const cookieRes = await request(app).post(importPath).send({
      domains: ["example.com"],
      cookies: [cookie({ domain: "app.octogee.com", name: "x" }), cookie({ domain: "example.com", name: "ok" })],
    });
    expect(cookieRes.status).toBe(200);
    expect(cookieRes.body.applied).toBe(1);
    expect(cookieRes.body.rejected[0].reason).toBe("forbidden_origin");
    expect(applyCookies).toHaveBeenLastCalledWith([expect.objectContaining({ name: "ok" })]);
  });

  it("returns 404 when the VM is not on this VM", async () => {
    const { app } = appForTest({ available: false });
    const res = await request(app).post(importPath).send({ domains: ["example.com"], cookies: [cookie({ domain: "example.com", name: "a" })] });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("computer_unavailable");
  });

  it("returns 403 for a viewer without control", async () => {
    const { app, applyCookies } = appForTest({ resolveAccess: async () => ({ kind: "allowed", gatewayId: "gw-alice", workspaceSlug: "alice", canControl: false }) });
    const res = await request(app).post(importPath).send({ domains: ["example.com"], cookies: [cookie({ domain: "example.com", name: "a" })] });
    expect(res.status).toBe(403);
    expect(applyCookies).not.toHaveBeenCalled();
  });

  it("maps forbidden and not_found access outcomes to status codes", async () => {
    const forbidden = appForTest({ resolveAccess: async () => ({ kind: "forbidden" }) });
    expect((await request(forbidden.app).post(importPath).send({ domains: ["example.com"], cookies: [] })).status).toBe(403);
    const missing = appForTest({ resolveAccess: async () => ({ kind: "not_found" }) });
    const res = await request(missing.app).post(importPath).send({ domains: ["example.com"], cookies: [cookie({ domain: "example.com", name: "a" })] });
    expect(res.status).toBe(404);
  });

  it("rejects an invalid payload and a non-registrable domain", async () => {
    const { app } = appForTest();
    expect((await request(app).post(importPath).send({ domains: ["example.com"], cookies: [], extra: 1 })).status).toBe(400);
    expect((await request(app).post(importPath).send({ domains: ["localhost"], cookies: [cookie({ domain: "localhost", name: "a" })] })).status).toBe(400);
  });

  it("rejects more cookies than the import cap", async () => {
    const { app } = appForTest();
    const cookies = Array.from({ length: 2001 }, (_, i) => cookie({ domain: "example.com", name: `c${i}` }));
    const res = await request(app).post(importPath).send({ domains: ["example.com"], cookies });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cookies");
  });

  it("reports cookies Chromium dropped as rejected not_stored instead of counting them applied", async () => {
    const { app } = appForTest({ applyCookies: async () => ({ stored: 1, dropped: [{ name: "b", domain: "example.com" }] }) });
    const res = await request(app).post(importPath).send({
      domains: ["example.com"],
      cookies: [cookie({ domain: "example.com", name: "a" }), cookie({ domain: "example.com", name: "b" })],
    });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(1);
    expect(res.body.rejected).toEqual([{ name: "b", domain: "example.com", reason: "not_stored" }]);
  });

  it("surfaces a CDP failure as 502", async () => {
    const { app } = appForTest({ applyCookies: async () => { throw new Error("cdp down"); } });
    const res = await request(app).post(importPath).send({ domains: ["example.com"], cookies: [cookie({ domain: "example.com", name: "a" })] });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("computer_unreachable");
  });
});
