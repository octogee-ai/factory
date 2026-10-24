import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createOpenClawBootSentinelStore } from "../lib/openclaw-boot-sentinel.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";
const recoveryReads = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@octogee/core/shared-source-recovery", async original => ({
  ...await original<typeof import("@octogee/core/shared-source-recovery")>(), readSharedSourceRecoveryAuthority: recoveryReads.read,
}));

const gatewayId = "shared-source", podName = "octogee-gateway-shared-source-abc123-def45", podUid = "source-pod";
const requestId = "source-repair", sourceSha = "a".repeat(40), digest = "b".repeat(64);
const images = { gateway: `registry/gateway:selected@sha256:${digest}`, "gateway-edge": `registry/edge:selected@sha256:${"c".repeat(64)}` };
const agent = { uid: "uid-alice", slug: "alice", agentId: "octogee-alice-coach", assignmentEpoch: 3 };
const input = { gatewayId, podName, podUid, releaseKey: "older-baked-image-build" };
function fixture() {
  const data: Record<string, any> = {
    [`glmGateways/${gatewayId}`]: { gatewayId },
    [`gateways/${gatewayId}`]: { gatewayId, ownerUid: null, builderSlug: null, latestRelease: 3, gatewayClass: "shared", desiredStatus: "draining", retirementClaim: null, desiredRelease: 3, liveRelease: 3,
      runtimeRestartFence: { kind: "source-recovery", attemptId: requestId, auditId: requestId, gatewayId, phase: "dispatched", startedAt: 100,
        target: { podName, podUid, sourceSha, images, agents: [agent] },
        installedImage: { podUid, gatewayImageId: `registry/gateway@sha256:${digest}`, verifiedAt: 200 },
        doctor: { requestId } } },
    [`glmOperations/${requestId}`]: { kind: "restart-gateway", status: "running", completedAt: null,
      input: { gatewayId, sourceRecovery: { root: { gatewayId, gatewayClass: "shared", ownerUid: null, builderSlug: null, desiredStatus: "draining", desiredRelease: 3, liveRelease: 3, latestRelease: 3 }, sourceSha, images, assignments: [{ ...agent, assignment: { state: "serving" } }] } } },
  };
  const ref = (path: string) => ({ path });
  const db = { doc: ref, collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    runTransaction: async (body: (txn: any) => Promise<any>) => {
      const writes: Array<{ path: string; patch: Record<string, unknown> }> = [];
      const result = await body({ get: async (r: { path: string }) => ({ exists: Object.hasOwn(data, r.path), data: () => data[r.path] }),
        update: (r: { path: string }, patch: Record<string, unknown>) => writes.push({ path: r.path, patch }) });
      for (const { path, patch } of writes) for (const [key, value] of Object.entries(patch)) {
        const parts = key.split("."); let target = data[path]; for (const part of parts.slice(0, -1)) { target = target[part] ??= {}; }
        target[parts.at(-1)!] = value;
      }
      return result;
    } };
  const store = createOpenClawBootSentinelStore(db as never, () => 300);
  const fence = () => data[`gateways/${gatewayId}`].runtimeRestartFence;
  const server = express(); server.disable("x-powered-by"); server.use(express.json());
  server.use(((req, _res, next) => { req.boundTenant = { kind: "gateway", gatewayId, podName, podUid, tokenSource: "ksa" } as never; next(); }) as RequestHandler);
  server.use("/internal/fleet", createFleetBrokerRoutes({ db: db as never, now: () => 300 }));
  return { data, store, fence, server };
}

describe("source Doctor boot authority", () => {
  function postgresFixture() {
    const f = fixture(), recovery = f.data[`glmOperations/${requestId}`].input.sourceRecovery;
    const stores = [{ ...agent, storeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", schema: "owned_coach" },
      { ...agent, agentId: "octogee-alice-proj-demo-coach", storeId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", schema: "owned_project" }];
    recovery.postgresAgentStores = stores;
    f.fence().target.postgresAgentStores = structuredClone(stores);
    const captured = { root: recovery.root, assignments: recovery.assignments, failedExports: [], postgresAgentStores: stores };
    recovery.failedExports = [];
    recoveryReads.read.mockResolvedValue(captured);
    return { ...f, recovery, stores, captured };
  }
  it("binds every PostgreSQL project anchor and exposes a read-only current-authority check during Doctor", async () => {
    const f = postgresFixture();
    const agentIds = f.stores.map(s => s.agentId);
    expect(await f.store.claim(input)).toEqual({ action: "doctor", sourceDoctor: { requestId, agentIds,
      postgresAgentStores: f.stores.map(({ agentId, storeId, schema }) => ({ agentId, storeId, schema })) } });
    const before = structuredClone(f.fence());
    await request(f.server).post("/internal/fleet/openclaw-boot/doctor-current").send({ gatewayId, revisionId: gatewayId, releaseKey: input.releaseKey, requestId }).expect(204);
    expect(f.fence()).toEqual(before);
    expect(f.fence().doctor.completedAt).toBeUndefined();
    expect(await f.store.completeDoctor({ ...input, requestId, verifiedAgentIds: agentIds })).toBe(true);
  });
  it.each(["owner", "anchor", "roster", "current-custody"])("refuses changed PostgreSQL %s before admitting maintenance", async changed => {
    const f = postgresFixture();
    if (changed === "owner") f.stores[1]!.uid = "foreign";
    if (changed === "anchor") f.stores[1]!.storeId = f.stores[0]!.storeId;
    if (changed === "roster") f.fence().target.postgresAgentStores.pop();
    if (changed === "current-custody") recoveryReads.read.mockResolvedValue({ ...f.captured, postgresAgentStores: [] });
    await expect(f.store.claim(input)).rejects.toThrow();
    expect(f.fence().doctor.startedAt).toBeUndefined();
  });
  it("rejects source custody lost after Doctor starts without publishing success", async () => {
    const f = postgresFixture(); await f.store.claim(input);
    recoveryReads.read.mockRejectedValue(new Error("source custody changed"));
    await expect(f.store.assertDoctor({ ...input, requestId })).rejects.toThrow("source custody changed");
    expect(f.fence().doctor.completedAt).toBeUndefined();
  });
  it("repairs and acknowledges a coach on its initial epoch-zero assignment", async () => {
    const f = fixture();
    const initialAgent = { ...agent, assignmentEpoch: 0 };
    f.fence().target.agents = [initialAgent];
    f.data[`glmOperations/${requestId}`].input.sourceRecovery.assignments = [{ ...initialAgent, assignment: { state: "serving" } }];

    expect(await f.store.claim(input)).toEqual({ action: "doctor", sourceDoctor: { requestId, agentIds: [agent.agentId] } });
    expect(await f.store.completeDoctor({ ...input, requestId, verifiedAgentIds: [agent.agentId] })).toBe(true);
    expect(await f.store.claim(input)).toEqual({ action: "start" });
  });

  it("binds actual installed image and Pod while treating a different baked build key only as correlation", async () => {
    const f = fixture();
    expect(await f.store.claim(input)).toEqual({ action: "doctor", sourceDoctor: { requestId, agentIds: [agent.agentId] } });
    expect(f.fence().doctor).toEqual({ requestId, releaseKey: input.releaseKey, startedAt: 300 });
    await expect(f.store.claim(input)).rejects.toThrow();
    expect(f.fence().doctor.completedAt).toBeUndefined();
  });
  it("leaves the request unspent until the controller verifies the installed gateway digest", async () => {
    const f = fixture(); delete f.fence().installedImage;
    expect(await f.store.claim(input)).toEqual({ action: "wait", sourceDoctor: { requestId, agentIds: [agent.agentId] } });
    expect(f.fence().doctor).toEqual({ requestId });
  });
  it.each(["pod", "image", "operation", "cancelled"])("rejects stale or foreign %s custody without spending Doctor", async (changed) => {
    const f = fixture();
    if (changed === "pod") f.fence().target.podUid = "foreign";
    if (changed === "image") f.fence().installedImage.gatewayImageId = `registry/gateway@sha256:${"d".repeat(64)}`;
    if (changed === "operation") f.data[`glmOperations/${requestId}`].status = "succeeded";
    if (changed === "cancelled") f.data[`glmOperations/${requestId}`].cancellationRequestedAt = 250;
    await expect(f.store.claim(input)).rejects.toThrow();
    expect(f.fence().doctor.startedAt).toBeUndefined();
  });
  it("does not let health certify or clear an unacknowledged repair", async () => {
    const f = fixture(); await f.store.claim(input);
    await expect(f.store.complete(input)).rejects.toThrow();
    expect(f.fence().doctor.completedAt).toBeUndefined();
    expect(f.fence().kind).toBe("source-recovery");
  });
  it("records exact native preflight acknowledgement during an owned pending retry, then permits start and health", async () => {
    const f = fixture(); await f.store.claim(input); f.data[`glmOperations/${requestId}`].status = "pending";
    const body = { gatewayId, revisionId: gatewayId, releaseKey: input.releaseKey, requestId, verifiedAgentIds: [agent.agentId] };
    await request(f.server).post("/internal/fleet/openclaw-boot/doctor-complete").send(body).expect(204);
    expect(f.fence().doctor).toEqual({ requestId, releaseKey: input.releaseKey, startedAt: 300, completedAt: 300, verifiedAgentIds: [agent.agentId] });
    expect(await f.store.claim(input)).toEqual({ action: "start" });
    expect(await f.store.complete(input)).toBe(true);
    expect(f.fence().doctor.completedAt).toBe(300);
  });
  it.each(["request", "key", "agents", "revision"])("refuses a mismatched %s success acknowledgement", async (changed) => {
    const f = fixture(); await f.store.claim(input);
    const body = { gatewayId, revisionId: gatewayId, releaseKey: input.releaseKey, requestId, verifiedAgentIds: [agent.agentId] };
    if (changed === "request") body.requestId = "foreign";
    if (changed === "key") body.releaseKey = "wrong";
    if (changed === "agents") body.verifiedAgentIds = [];
    if (changed === "revision") body.revisionId = "foreign";
    const response = await request(f.server).post("/internal/fleet/openclaw-boot/doctor-complete").send(body);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(f.fence().doctor.completedAt).toBeUndefined();
  });
});
