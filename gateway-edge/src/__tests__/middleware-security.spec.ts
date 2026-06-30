import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { globalRateLimit, helmetMiddleware } from "../middleware/security.js";

describe("security middleware", () => {
  it("sets the locked-down content security policy", async () => {
    const app = express();
    app.use(helmetMiddleware);
    app.get("/probe", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/probe").expect(200);

    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("skips global rate-limit headers for health and metrics routes", async () => {
    const app = express();
    app.use(globalRateLimit);
    app.get("/health", (_req, res) => res.json({ ok: true }));
    app.get("/api/probe", (_req, res) => res.json({ ok: true }));

    const health = await request(app).get("/health").expect(200);
    const probe = await request(app).get("/api/probe").expect(200);

    expect(health.headers.ratelimit).toBeUndefined();
    expect(probe.headers.ratelimit).toBeDefined();
  });
});
