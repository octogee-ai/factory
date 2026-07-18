import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import {
  globalRateLimit,
  helmetMiddleware,
  internalRateLimit,
  isWellFormedServiceAccountJwt,
} from "../middleware/security.js";

const ORIGINAL_INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY;

const WELL_FORMED_SA_TOKEN = [
  "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5LWlkIn0",
  "eyJhdWQiOlsib2N0b2dlZS1hcGkiXSwiZXhwIjoxNzUyODAwMDAwLCJpc3MiOiJrOHMifQ",
  "c2lnbmF0dXJlLXNlZ21lbnQtZm9yLXRlc3RpbmctcHVycG9zZXMtb25seQ",
].join(".");

function limiterApp() {
  const app = express();
  app.use(globalRateLimit);
  app.use(internalRateLimit);
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/internal/gitea/user-pubkey", (_req, res) => res.json({ ok: true }));
  app.get("/api/probe", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("security middleware", () => {
  afterEach(() => {
    if (ORIGINAL_INTERNAL_SERVICE_KEY === undefined) {
      delete process.env.INTERNAL_SERVICE_KEY;
      return;
    }
    process.env.INTERNAL_SERVICE_KEY = ORIGINAL_INTERNAL_SERVICE_KEY;
  });

  it("sets the locked-down content security policy", async () => {
    const app = express();
    app.use(helmetMiddleware);
    app.get("/probe", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/probe").expect(200);

    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("skips all rate-limit buckets for health and validated platform-key internal requests", async () => {
    process.env.INTERNAL_SERVICE_KEY = "configured-platform-key";
    const app = limiterApp();

    const health = await request(app).get("/health").expect(200);
    const platformInternal = await request(app)
      .get("/internal/gitea/user-pubkey")
      .set("x-internal-service-key", "configured-platform-key")
      .expect(200);

    expect(health.headers.ratelimit).toBeUndefined();
    expect(platformInternal.headers.ratelimit).toBeUndefined();
  });

  it("moves well-formed token-bearing internal requests to the internal bucket instead of exempting them", async () => {
    const app = limiterApp();

    const internal = await request(app)
      .get("/internal/gitea/user-pubkey")
      .set("x-k8s-sa-token", WELL_FORMED_SA_TOKEN)
      .expect(200);

    expect(internal.headers.ratelimit).toContain("limit=1200");
  });

  it("keeps the global cap on internal requests whose token is malformed or whose key is forged", async () => {
    process.env.INTERNAL_SERVICE_KEY = "configured-platform-key";
    const app = limiterApp();

    const junkToken = await request(app)
      .get("/internal/gitea/user-pubkey")
      .set("x-k8s-sa-token", "junk")
      .expect(200);
    const forgedKey = await request(app)
      .get("/internal/gitea/user-pubkey")
      .set("x-internal-service-key", "wrong-platform-key")
      .expect(200);
    const unauthenticated = await request(app).get("/internal/gitea/user-pubkey").expect(200);

    expect(junkToken.headers.ratelimit).toContain("limit=300");
    expect(forgedKey.headers.ratelimit).toContain("limit=300");
    expect(unauthenticated.headers.ratelimit).toContain("limit=300");
  });

  it("keeps ordinary API traffic on the global bucket and off the internal bucket", async () => {
    const app = limiterApp();

    const probe = await request(app)
      .get("/api/probe")
      .set("x-k8s-sa-token", WELL_FORMED_SA_TOKEN)
      .expect(200);

    expect(probe.headers.ratelimit).toContain("limit=300");
  });
});

describe("isWellFormedServiceAccountJwt", () => {
  it("accepts a three-segment base64url token of plausible length", () => {
    expect(isWellFormedServiceAccountJwt(WELL_FORMED_SA_TOKEN)).toBe(true);
  });

  it.each([
    ["junk", "junk"],
    ["two segments", "aGVhZGVy.cGF5bG9hZA"],
    ["four segments", "aGVhZGVy.cGF5bG9hZA.c2ln.ZXh0cmE"],
    ["empty segment", "aGVhZGVy..c2lnbmF0dXJlLXNlZ21lbnQtb2YtcGxhdXNpYmxlLWxlbmd0aA"],
    ["non-base64url characters", `${"a".repeat(20)}!.${"b".repeat(20)}.${"c".repeat(20)}`],
    ["empty string", ""],
  ])("rejects %s", (_label, token) => {
    expect(isWellFormedServiceAccountJwt(token)).toBe(false);
  });

  it("rejects tokens beyond the 8 KiB review bound", () => {
    const oversized = `${"a".repeat(4000)}.${"b".repeat(4000)}.${"c".repeat(300)}`;
    expect(isWellFormedServiceAccountJwt(oversized)).toBe(false);
  });
});
