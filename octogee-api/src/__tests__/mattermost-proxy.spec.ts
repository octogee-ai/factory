import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import {
  mmRestProxyHandler,
  setMmCredsCache,
  mmCredsCache,
  MM_CREDS_CACHE_MAX,
} from "../routes/mattermost-proxy.js";

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe("mmRestProxyHandler — fail-closed on misconfiguration", () => {
  it("returns 502 when MM_INTERNAL_URL is unset (no env in the test runner)", () => {

const res = mockRes();
    mmRestProxyHandler({ method: "GET", url: "/api/v4/users/me", headers: {} } as Request, res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error: expect.stringContaining("misconfigured") });
  });
});

describe("mmCredsCache — bounded on the cluster singleton", () => {
  beforeEach(() => mmCredsCache.clear());

  it("never grows past MM_CREDS_CACHE_MAX, evicting oldest-inserted first", () => {
    const future = Date.now() + 60_000;
    for (let i = 0; i < MM_CREDS_CACHE_MAX + 250; i++) {
      setMmCredsCache(`uid-${i}`, { mmToken: "t", mmUserId: "u", expiresAt: future });
    }
    expect(mmCredsCache.size).toBeLessThanOrEqual(MM_CREDS_CACHE_MAX);
    
    expect(mmCredsCache.has(`uid-${MM_CREDS_CACHE_MAX + 249}`)).toBe(true);
    expect(mmCredsCache.has("uid-0")).toBe(false);
  });

  it("drops expired entries before evicting live ones on overflow", () => {
    const past = Date.now() - 1;
    const future = Date.now() + 60_000;
    
    for (let i = 0; i < MM_CREDS_CACHE_MAX; i++) {
      setMmCredsCache(`stale-${i}`, { mmToken: "t", mmUserId: "u", expiresAt: past });
    }
    
    setMmCredsCache("fresh", { mmToken: "t", mmUserId: "u", expiresAt: future });
    expect(mmCredsCache.has("fresh")).toBe(true);
    expect(mmCredsCache.size).toBeLessThanOrEqual(MM_CREDS_CACHE_MAX);
  });
});
