import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { globalRateLimit, helmetMiddleware } from "../middleware/security.js";

const ORIGINAL_INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY;

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

  it("skips global rate-limit headers for health, metrics, and authenticated internal routes", async () => {
    process.env.INTERNAL_SERVICE_KEY = "configured-platform-key";
    const app = express();
    app.use(globalRateLimit);
    app.get("/health", (_req, res) => res.json({ ok: true }));
    app.get("/internal/gitea/user-pubkey", (_req, res) => res.json({ ok: true }));
    app.get("/api/probe", (_req, res) => res.json({ ok: true }));

    const health = await request(app).get("/health").expect(200);
    const internal = await request(app)
      .get("/internal/gitea/user-pubkey")
      .set("x-k8s-sa-token", "projected-service-account-token")
      .expect(200);
    const platformInternal = await request(app)
      .get("/internal/gitea/user-pubkey")
      .set("x-internal-service-key", "configured-platform-key")
      .expect(200);
    const forgedPlatformInternal = await request(app)
      .get("/internal/gitea/user-pubkey")
      .set("x-internal-service-key", "wrong-platform-key")
      .expect(200);
    const unauthInternal = await request(app).get("/internal/gitea/user-pubkey").expect(200);
    const probe = await request(app).get("/api/probe").expect(200);

    expect(health.headers.ratelimit).toBeUndefined();
    expect(internal.headers.ratelimit).toBeUndefined();
    expect(platformInternal.headers.ratelimit).toBeUndefined();
    expect(forgedPlatformInternal.headers.ratelimit).toBeDefined();
    expect(unauthInternal.headers.ratelimit).toBeDefined();
    expect(probe.headers.ratelimit).toBeDefined();
  });
});
