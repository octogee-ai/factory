import express from "express";
import type { Firestore } from "firebase-admin/firestore";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { BoundTenant } from "../lib/sa-to-tenant.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

function appWith(docs: Record<string, Record<string, unknown>>, bound: BoundTenant | null, writes: Array<[string, unknown]> = [], deletedAfterRead = new Set<string>()) {
  const db = {
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs[path] !== undefined, data: () => docs[path] }),
      update: async (next: unknown) => {
        if (deletedAfterRead.has(path)) throw Object.assign(new Error("5 NOT_FOUND: no entity to update"), { code: 5 });
        writes.push([path, next]);
      },
    }),
    collection: () => { throw new Error("unexpected collection access"); },
  } as unknown as Firestore;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (bound) req.boundTenant = bound;
    next();
  });
  app.use("/internal/fleet", createFleetBrokerRoutes({ db, now: () => 5_000 }));
  return app;
}
const gateway: BoundTenant = { kind: "gateway", gatewayId: "b-x" };

describe("POST /internal/fleet/computer-egress", () => {
  it("reads the bound gateway's stored egress mode, null when none was ever chosen", async () => {
    const empty = await request(appWith({ "glmGateways/b-x": { gatewayId: "b-x" } }, gateway)).post("/internal/fleet/computer-egress").send({});
    expect(empty.status).toBe(200);
    expect(empty.headers["cache-control"]).toBe("no-store");
    expect(empty.body).toEqual({ egress: null });

    const chosen = await request(appWith({ "glmGateways/b-x": { gatewayId: "b-x", vmEgress: { mode: "desktop", updatedAt: 4_000 } } }, gateway))
      .post("/internal/fleet/computer-egress").send({ gatewayId: "b-x" });
    expect(chosen.body).toEqual({ egress: { mode: "desktop", updatedAt: 4_000 } });
  });

  it("writes a chosen mode beside the Cowboy-owned vm map and echoes it", async () => {
    const writes: Array<[string, unknown]> = [];
    const res = await request(appWith({ "glmGateways/b-x": { gatewayId: "b-x", vm: { status: "RUNNING" } } }, gateway, writes))
      .post("/internal/fleet/computer-egress").send({ mode: "desktop" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ egress: { mode: "desktop", updatedAt: 5_000 } });
    expect(writes).toEqual([["glmGateways/b-x", { vmEgress: { mode: "desktop", updatedAt: 5_000 } }]]);
  });

  it("answers 404 without recreating the gateway when it is retired between the read and the mode write", async () => {
    const writes: Array<[string, unknown]> = [];
    const res = await request(appWith({ "glmGateways/b-x": { gatewayId: "b-x" } }, gateway, writes, new Set(["glmGateways/b-x"])))
      .post("/internal/fleet/computer-egress").send({ mode: "desktop" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "gateway_not_found" });
    expect(writes).toEqual([]);
  });

  it("rejects an unknown mode, refuses to read a malformed stored record while still letting a write repair it, and refuses any binding that is not the gateway itself", async () => {
    const writes: Array<[string, unknown]> = [];
    const bad = await request(appWith({ "glmGateways/b-x": { gatewayId: "b-x" } }, gateway, writes)).post("/internal/fleet/computer-egress").send({ mode: "tor" });
    expect(bad.status).toBe(400);
    expect(writes).toEqual([]);

    const malformed = await request(appWith({ "glmGateways/b-x": { gatewayId: "b-x", vmEgress: { mode: "desktop" } } }, gateway)).post("/internal/fleet/computer-egress").send({});
    expect(malformed.status).toBe(409);
    expect(malformed.body).toEqual({ error: "egress_record_malformed" });
    const repaired = await request(appWith({ "glmGateways/b-x": { gatewayId: "b-x", vmEgress: { mode: "desktop" } } }, gateway, writes)).post("/internal/fleet/computer-egress").send({ mode: "cloud" });
    expect(repaired.status).toBe(200);
    expect(writes).toEqual([["glmGateways/b-x", { vmEgress: { mode: "cloud", updatedAt: 5_000 } }]]);

    const foreign = await request(appWith({ "glmGateways/b-x": { gatewayId: "b-x" } }, gateway)).post("/internal/fleet/computer-egress").send({ gatewayId: "b-y", mode: "cloud" });
    expect(foreign.status).toBe(403);
    const unbound = await request(appWith({ "glmGateways/b-x": { gatewayId: "b-x" } }, null)).post("/internal/fleet/computer-egress").send({ mode: "cloud" });
    expect(unbound.status).toBe(403);
    const missing = await request(appWith({}, gateway)).post("/internal/fleet/computer-egress").send({ mode: "cloud" });
    expect(missing.status).toBe(404);
  });
});
