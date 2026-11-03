import express from "express";
import type { Firestore } from "firebase-admin/firestore";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { BoundTenant } from "../lib/sa-to-tenant.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const bundle = {
  version: "v1", gatewayId: "b-x", namespace: "octogee-test", imageRepository: "r", imageTag: "t", desktop: "omarchy", init: null,
  containers: [{ name: "gateway", image: "r:t", env: { A: "1" }, command: null, args: null, mounts: [] }],
  volumes: [], hostAliases: {}, kubernetes: { apiHost: "10.128.0.2", apiPort: "443", caCert: "c" },
  renderedAt: 1,
};

function appWith(docs: Record<string, Record<string, unknown>>, bound: BoundTenant | null, writes: Array<[string, unknown]> = [], writeFails = false, beforeTransaction?: () => void) {
  const db = {
    doc: (path: string) => ({
      path,
      get: async () => ({ exists: docs[path] !== undefined, data: () => docs[path] }),
      set: async (next: unknown) => {
        if (writeFails) throw new Error("14 UNAVAILABLE");
        writes.push([path, next]);
      },
    }),
    runTransaction: async (work: (tx: unknown) => Promise<void>) => {
      beforeTransaction?.();
      return work({
        get: (ref: { get: () => unknown }) => ref.get(),
        set: (ref: { path: string }, next: unknown) => {
          if (writeFails) throw new Error("14 UNAVAILABLE");
          writes.push([ref.path, next]);
        },
      });
    },
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

  it("keeps serving a bundle rendered before bundles named their desktop, and refuses an unknown desktop", async () => {
    const { desktop: _desktop, ...omarchyEra } = bundle;
    const served = await request(appWith({ "glmGateways/b-x/vm/runtime": omarchyEra }, { kind: "gateway", gatewayId: "b-x" }))
      .post("/internal/fleet/vm-runtime").send({});
    expect(served.status).toBe(200);
    expect(served.body.bundle).toEqual(omarchyEra);
    const unknown = await request(appWith({ "glmGateways/b-x/vm/runtime": { ...bundle, desktop: "kde" } }, { kind: "gateway", gatewayId: "b-x" }))
      .post("/internal/fleet/vm-runtime").send({});
    expect(unknown.status).toBe(404);
  });

  it("404s when nothing is rendered or the bundle names another gateway, and 403s without a gateway binding", async () => {
    expect((await request(appWith({}, { kind: "gateway", gatewayId: "b-x" })).post("/internal/fleet/vm-runtime").send({})).status).toBe(404);
    expect((await request(appWith({ "glmGateways/b-x/vm/runtime": { ...bundle, gatewayId: "b-y" } }, { kind: "gateway", gatewayId: "b-x" })).post("/internal/fleet/vm-runtime").send({})).status).toBe(404);
    expect((await request(appWith({ "glmGateways/b-x/vm/runtime": bundle }, null)).post("/internal/fleet/vm-runtime").send({})).status).toBe(403);
    expect((await request(appWith({ "glmGateways/b-x/vm/runtime": bundle }, { kind: "platform", actor: "cron" })).post("/internal/fleet/vm-runtime").send({})).status).toBe(403);
  });

  it("binds boot-recovery capacity/readiness to the same instance/version and server time", async () => {
    const docs = { "glmGateways/b-x/vm/runtime": bundle, "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vm: { instanceId: "4242" } } };
    const sample = { currentPointId: "image-one-" + "a".repeat(32), retainedPoints: 1, ready: true, bundleVersion: "v1", freeBytes: 3 * 1024 ** 3 };
    const writes: Array<[string, unknown]> = [];
    const result = await request(appWith(docs, { kind: "gateway", gatewayId: "b-x", podUid: "4242" }, writes)).post("/internal/fleet/vm-runtime").send({ bootRecovery: { ...sample, instanceId: "forged", observedAt: 99999 } });
    expect(result.status).toBe(200);
    expect(writes).toEqual([["glmGateways/b-x", { vmBootRecovery: { ...sample, instanceId: "4242", observedAt: 5000 } }]]);
    for (const [podUid, bundleVersion] of [["other", "v1"], ["4242", "old"]]) {
      const other: Array<[string, unknown]> = [];
      expect((await request(appWith(docs, { kind: "gateway", gatewayId: "b-x", podUid }, other)).post("/internal/fleet/vm-runtime").send({ bootRecovery: { ...sample, bundleVersion } })).status).toBe(200);
      expect(other).toEqual([]);
    }
    expect((await request(appWith(docs, { kind: "gateway", gatewayId: "b-x", podUid: "4242" })).post("/internal/fleet/vm-runtime").send({ bootRecovery: { ...sample, retainedPoints: -1 } })).status).toBe(400);
    const failed: Array<[string, unknown]> = [];
    expect((await request(appWith(docs, { kind: "gateway", gatewayId: "b-x", podUid: "4242" }, failed)).post("/internal/fleet/vm-runtime").send({ bootRecovery: { ...sample, ready: false, bundleVersion: "unavailable" } })).status).toBe(200);
    expect(failed).toEqual([["glmGateways/b-x", { vmBootRecovery: { ...sample, ready: false, bundleVersion: "unavailable", instanceId: "4242", observedAt: 5000 } }]]);
    expect((await request(appWith(docs, { kind: "gateway", gatewayId: "b-x", podUid: "4242" }, [], true)).post("/internal/fleet/vm-runtime").send({ bootRecovery: sample })).status).toBe(503);
    const raced: Array<[string, unknown]> = [];
    const response = await request(appWith(docs, { kind: "gateway", gatewayId: "b-x", podUid: "4242" }, raced, false, () => { docs["glmGateways/b-x"].vm.instanceId = "new"; })).post("/internal/fleet/vm-runtime").send({ bootRecovery: sample });
    expect(response.status).toBe(200);
    expect(raced).toEqual([]);
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

  it("records image observations with broker time and current instance identity, excluding guest metadata", async () => {
    const writes: Array<[string, unknown]> = [];
    const containers = [
      { name: "gateway", imageReference: "registry.example/gateway:actual", digests: [`registry.example/gateway@sha256:${"a".repeat(64)}`], running: true },
      { name: "gateway-edge", imageReference: "", digests: [], running: false },
    ];
    const docs = { "glmGateways/b-x/vm/runtime": bundle, "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vm: { instanceId: "4242" } } };
    const bound: BoundTenant = { kind: "gateway", gatewayId: "b-x", podUid: "4242" };
    const response = await request(appWith(docs, bound, writes)).post("/internal/fleet/vm-runtime")
      .send({ images: { containers: containers.map(c => ({ ...c, env: "secret" })), observedAt: 999_999, instanceId: "forged" } });
    expect(response.status).toBe(200);
    expect(writes).toEqual([["glmGateways/b-x", { vmImages: { instanceId: "4242", observedAt: 5_000, containers } }]]);

    for (const other of [{ ...bound, podUid: "old" }, { kind: "gateway", gatewayId: "b-x" } as BoundTenant]) {
      const foreign: Array<[string, unknown]> = [];
      expect((await request(appWith(docs, other, foreign)).post("/internal/fleet/vm-runtime").send({ images: { containers } })).status).toBe(200);
      expect(foreign).toEqual([]);
    }
    const raced: Array<[string, unknown]> = [];
    await request(appWith(docs, bound, raced, false, () => { docs["glmGateways/b-x"].vm.instanceId = "replacement"; }))
      .post("/internal/fleet/vm-runtime").send({ images: { containers } });
    expect(raced).toEqual([]);
  });

  it("fails visibly when image observation persistence fails", async () => {
    const docs = { "glmGateways/b-x/vm/runtime": bundle, "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vm: { instanceId: "4242" } } };
    const containers = ["gateway", "gateway-edge"].map(name => ({ name, imageReference: "", digests: [], running: false }));
    const response = await request(appWith(docs, { kind: "gateway", gatewayId: "b-x", podUid: "4242" }, [], true))
      .post("/internal/fleet/vm-runtime").send({ images: { containers } });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "image_observation_unrecorded" });
  });

  it("rejects incomplete, duplicate, oversized and malformed image observations", async () => {
    const missing = { name: "gateway", imageReference: "", digests: [], running: false };
    const edge = { ...missing, name: "gateway-edge" };
    const docs = { "glmGateways/b-x/vm/runtime": bundle, "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vm: { instanceId: "4242" } } };
    for (const containers of [[], [missing], [missing, missing], [missing, edge, edge],
      [{ ...missing, running: true }, edge], [{ ...missing, imageReference: "x", digests: ["sha256:bad"] }, edge],
      [{ ...missing, imageReference: "x".repeat(1025) }, edge]]) {
      const writes: Array<[string, unknown]> = [];
      const response = await request(appWith(docs, { kind: "gateway", gatewayId: "b-x", podUid: "4242" }, writes))
        .post("/internal/fleet/vm-runtime").send({ images: { containers } });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "invalid_image_sample" });
      expect(writes).toEqual([]);
    }
  });

  it("records the bound instance's Spot preemption notice with the API's clock, ignores another instance's, and rejects a malformed one", async () => {
    const vmBound: BoundTenant = { kind: "gateway", gatewayId: "b-x", podUid: "4242" };
    const glm = { gatewayId: "b-x", runtime: "gce-vm", vm: { instanceId: "4242", status: "RUNNING" } };

    const writes: Array<[string, unknown]> = [];
    const recorded = await request(appWith({ "glmGateways/b-x/vm/runtime": bundle, "glmGateways/b-x": glm }, vmBound, writes))
      .post("/internal/fleet/vm-runtime").send({ preempted: true });
    expect(recorded.status).toBe(200);
    expect(writes).toEqual([["glmGateways/b-x", { vmPreemption: { instanceId: "4242", announcedAt: 5_000 } }]]);

    const foreign: Array<[string, unknown]> = [];
    await request(appWith({ "glmGateways/b-x/vm/runtime": bundle, "glmGateways/b-x": glm }, { ...vmBound, podUid: "9999" }, foreign))
      .post("/internal/fleet/vm-runtime").send({ preempted: true });
    expect(foreign).toEqual([]);

    const malformed = await request(appWith({ "glmGateways/b-x/vm/runtime": bundle, "glmGateways/b-x": glm }, vmBound))
      .post("/internal/fleet/vm-runtime").send({ preempted: "yes" });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "invalid_preemption_notice" });

    const unrecorded = await request(appWith({ "glmGateways/b-x/vm/runtime": bundle, "glmGateways/b-x": glm }, vmBound, [], true))
      .post("/internal/fleet/vm-runtime").send({ preempted: true });
    expect(unrecorded.status).toBe(503);
    expect(unrecorded.body).toEqual({ error: "preemption_notice_unrecorded" });
  });
  it("carries a valid recovery obligation to the agent and refuses corrupt metadata", async () => {
    const saved = { name: "20260905T101500Z.tar.gz", size: 2048, sha256: "a".repeat(64), instanceId: "previous", generation: "9007199254740995", completedAt: 1000 };
    const bound: BoundTenant = { kind: "gateway", gatewayId: "b-x", podUid: "4242" };
    const docs = { "glmGateways/b-x/vm/runtime": bundle, "glmGateways/b-x": { gatewayId: "b-x", runtime: "gce-vm", vm: { instanceId: "4242" }, vmHome: { restoreCheckpoint: saved } } };
    const response = await request(appWith(docs, bound)).post("/internal/fleet/vm-runtime").send({});
    expect(response.status).toBe(200);
    expect(response.body.bundle.homeRestoreCheckpoint).toEqual(saved);
    const malformed = { ...docs, "glmGateways/b-x": { ...docs["glmGateways/b-x"], vmHome: { restoreCheckpoint: { ...saved, generation: 123 } } } };
    expect((await request(appWith(malformed, bound)).post("/internal/fleet/vm-runtime").send({})).status).toBe(409);
  });

});
