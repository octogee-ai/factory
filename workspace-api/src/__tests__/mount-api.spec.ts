import express, { Router } from "express";
import request from "supertest";
import { describe, it, expect } from "vitest";

import { mountApi } from "../routes/mount-api";

describe("mountApi — fleet path-affinity seam (FLEET-API-ROUTING-SPEC)", () => {
  it("mounts a router at /api/<p> AND /api/g/:gatewayId/<p>", async () => {
    const app = express();
    const r = Router();
    r.get("/files", (_req, res) => {
      res.json({ ok: true });
    });
    mountApi(app, "/workspace", r);

    const unscoped = await request(app).get("/api/workspace/files");
    const scoped = await request(app).get("/api/g/gw-bender/workspace/files");
    expect(unscoped.status).toBe(200);
    expect(scoped.status).toBe(200);
    expect(unscoped.body).toEqual({ ok: true });
    expect(scoped.body).toEqual({ ok: true });
  });

  it("exposes :gatewayId on req.params when mergeParams routers ask for it (routing key, not authz)", async () => {
    const app = express();
    const r = Router({ mergeParams: true });
    r.get("/probe", (req, res) => {
      res.json({ gatewayId: (req.params as { gatewayId?: string }).gatewayId ?? null });
    });
    mountApi(app, "/x", r);

    const scoped = await request(app).get("/api/g/gw-bender/x/probe");
    const unscoped = await request(app).get("/api/x/probe");
    expect(scoped.body).toEqual({ gatewayId: "gw-bender" });
    expect(unscoped.body).toEqual({ gatewayId: null });
  });

  it("registers BOTH forms — each one independently 404s only the unmounted leaf, not the mount", async () => {
    const app = express();
    const r = Router();
    r.get("/exists", (_req, res) => {
      res.json({ ok: true });
    });
    mountApi(app, "/y", r);

    // /api/y/exists and /api/g/whatever/y/exists hit the router; /api/y/missing
    // and /api/g/whatever/y/missing hit the router and 404 from inside (the
    // mount itself is present under both forms).
    expect((await request(app).get("/api/y/exists")).status).toBe(200);
    expect((await request(app).get("/api/g/gw-foo/y/exists")).status).toBe(200);
    expect((await request(app).get("/api/y/missing")).status).toBe(404);
    expect((await request(app).get("/api/g/gw-foo/y/missing")).status).toBe(404);
  });
});
