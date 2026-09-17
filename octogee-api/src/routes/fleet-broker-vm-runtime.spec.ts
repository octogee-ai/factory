import express from "express";
import type { Firestore } from "firebase-admin/firestore";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { BoundTenant } from "../lib/sa-to-tenant.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const bundle = {
  version: "v1", gatewayId: "b-x", namespace: "octogee-test", imageRepository: "r", imageTag: "t", init: null,
  containers: [{ name: "gateway", image: "r:t", env: { A: "1" }, command: null, args: null, mounts: [] }],
  volumes: [], hostAliases: {}, kubernetes: { apiHost: "10.128.0.2", apiPort: "443", caCert: "c" },
  renderedAt: 1,
};

function appWith(docs: Record<string, Record<string, unknown>>, bound: BoundTenant | null, writes: Array<[string, unknown]> = []) {
  const db = {
    doc: (path: string) => ({
      get: async () => ({ exists: docs[path] !== undefined, data: () => docs[path] }),
      set: async (next: unknown) => { writes.push([path, next]); },
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

describe("POST /internal/fleet/vm-runtime", () => {
  it("returns the bound gateway's rendered runtime bundle and home-checkpoint signal, uncached", async () => {
    const res = await request(appWith({ "glmGateways/b-x/vm/runtime": bundle }, { kind: "gateway", gatewayId: "b-x" }))
      .post("/internal/fleet/vm-runtime").send({});
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ bundle, homeCheckpoint: { requestedAt: null, completedAt: null } });

    const requested = await request(appWith({
      "glmGateways/b-x/vm/runtime": bundle,
      "glmGateways/b-x": { gatewayId: "b-x", vmHome: { checkpointRequestedAt: 50, lastCheckpoint: { name: "20260905T101500Z.tar.gz", size: 1, sha256: "a".repeat(64), instanceId: "1", completedAt: 40 } } },
    }, { kind: "gateway", gatewayId: "b-x" })).post("/internal/fleet/vm-runtime").send({});
    expect(requested.body.homeCheckpoint).toEqual({ requestedAt: 50, completedAt: null });
  });

  it("404s when nothing is rendered or the bundle names another gateway, and 403s without a gateway binding", async () => {
    expect((await request(appWith({}, { kind: "gateway", gatewayId: "b-x" })).post("/internal/fleet/vm-runtime").send({})).status).toBe(404);
    expect((await request(appWith({ "glmGateways/b-x/vm/runtime": { ...bundle, gatewayId: "b-y" } }, { kind: "gateway", gatewayId: "b-x" })).post("/internal/fleet/vm-runtime").send({})).status).toBe(404);
    expect((await request(appWith({ "glmGateways/b-x/vm/runtime": bundle }, null)).post("/internal/fleet/vm-runtime").send({})).status).toBe(403);
    expect((await request(appWith({ "glmGateways/b-x/vm/runtime": bundle }, { kind: "platform", actor: "cron" })).post("/internal/fleet/vm-runtime").send({})).status).toBe(403);
  });

  it("records the bound instance's disk report on the runtime doc, ignores another instance's, and rejects a malformed one", async () => {
    const vmBound: BoundTenant = { kind: "gateway", gatewayId: "b-x", podUid: "4242" };
    const glm = { gatewayId: "b-x", runtime: "gce-vm", vm: { instanceId: "4242", status: "RUNNING" } };
    const disk = { sizeBytes: 42_949_672_960, freeBytes: 3_221_225_472 };

    const writes: Array<[string, unknown]> = [];
    const recorded = await request(appWith({ "glmGateways/b-x/vm/runtime": bundle, "glmGateways/b-x": glm }, vmBound, writes))
      .post("/internal/fleet/vm-runtime").send({ disk });
    expect(recorded.status).toBe(200);
    expect(recorded.body.bundle).toEqual(bundle);
    expect(writes).toEqual([["glmGateways/b-x", { vmDisk: { ...disk, instanceId: "4242", observedAt: 5_000 } }]]);

    const foreign: Array<[string, unknown]> = [];
    const stale = await request(appWith({ "glmGateways/b-x/vm/runtime": bundle, "glmGateways/b-x": glm }, { ...vmBound, podUid: "9999" }, foreign))
      .post("/internal/fleet/vm-runtime").send({ disk });
    expect(stale.status).toBe(200);
    expect(foreign).toEqual([]);

    const malformed = await request(appWith({ "glmGateways/b-x/vm/runtime": bundle, "glmGateways/b-x": glm }, vmBound))
      .post("/internal/fleet/vm-runtime").send({ disk: { sizeBytes: 10, freeBytes: 11 } });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "invalid_disk_sample" });
  });
});
