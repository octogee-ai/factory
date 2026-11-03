import express from "express";
import type { Firestore } from "firebase-admin/firestore";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { addAdminFleetRoutes } from "./admin-fleet-router.js";

const GATEWAY = "b-fixture";
const OWNER = "fixture-owner";
const gateway = {
  gatewayId: GATEWAY, desiredStatus: "running",
  createdAt: 1, createdBy: "operator", updatedAt: 1, updatedBy: "operator",
  latestRelease: 1, desiredRelease: 1, liveRelease: 1,
  configSchemaVersion: 1, profile: "builder", gatewayClass: "builder", imageProfile: "builder",
  sizingTier: "s", gcpProject: "octogee-test", gatewayContainerSecurityContext: null,
  serviceAccountName: null, serviceAccount: null, builderAccess: null,
  ownerUid: OWNER, builderSlug: "fixture", modelBrokerLimits: null,
};
const vm = { instanceName: "octo-fixture", zone: "us-central1-a", instanceId: "123", status: "RUNNING" };
const parked = { ...vm, gatewayId: GATEWAY, parkedAt: 100, checkpoint: { outcome: "fresh", requestedAt: 90, completedAt: 95 } };

function harness(overrides: Record<string, Record<string, unknown> | null> = {}, role = "admin", computerReplacementEnabled: boolean | undefined = true) {
  const store = new Map<string, Record<string, unknown>>(Object.entries({
    [`gateways/${GATEWAY}`]: gateway,
    "gateways/shared-a": { gatewayClass: "shared" },
    [`gateways/shared-a/assignments/${OWNER}`]: { uid: OWNER, gatewayId: "shared-a", state: "serving", epoch: 1 },
    [`glmGateways/${GATEWAY}`]: { gatewayId: GATEWAY, runtime: "gce-vm", vm },
    [`users/${OWNER}`]: { username: "fixture", provisioning: { openclaw: { gatewayId: GATEWAY } } },
  }));
  for (const [path, value] of Object.entries(overrides)) {
    if (value === null) store.delete(path); else store.set(path, value);
  }
  let serial = Promise.resolve();
  let nextId = 0;
  const doc = (path: string) => ({
    path, id: path.split("/").at(-1)!,
    get: async () => ({ id: path.split("/").at(-1)!, exists: store.has(path), data: () => store.get(path) }),
  });
  const collection = (path: string) => ({
    doc: (id = `new-${++nextId}`) => doc(`${path}/${id}`),
    where: (_field: string, _operator: string, statuses: string[]) => ({
      get: async () => ({ docs: [...store.entries()].filter(([key, value]) => key.startsWith(`${path}/`) && statuses.includes(value.status as string)).map(([key, value]) => ({ id: key.split("/").at(-1)!, data: () => value })) }),
    }),
  });
  const db = {
    doc, collection,
    runTransaction: (body: (tx: unknown) => Promise<unknown>) => {
      const pending = serial.then(async () => {
        const writes: Array<() => void> = [];
        const result = await body({
          get: (ref: { get: () => Promise<unknown> }) => ref.get(),
          create: (ref: { path: string }, value: Record<string, unknown>) => writes.push(() => {
            if (store.has(ref.path)) { throw new Error("already exists"); }
            store.set(ref.path, value);
          }),
          update: (ref: { path: string }, value: Record<string, unknown>) => writes.push(() => {
            const target = store.get(ref.path)!;
            for (const [path, field] of Object.entries(value)) {
              const parts = path.split(".");
              let cursor = target;
              for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>;
              cursor[parts.at(-1)!] = field;
            }
          }),
        });
        for (const write of writes) write();
        return result;
      });
      serial = pending.then(() => undefined, () => undefined);
      return pending;
    },
  } as unknown as Firestore;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { uid: role === "anonymous" ? undefined : "operator", isAdmin: role === "admin" }); next(); });
  addAdminFleetRoutes(app, { db, computerReplacementEnabled, logger: { info: vi.fn(), warn: vi.fn() }, workspaceSlugsForUser: () => ["fixture"], provisionGatewayAuthSecret: vi.fn(), listGatewayBuilds: vi.fn(), suspendAuthUser: vi.fn(), revokeConnectorGrantsForUser: vi.fn() });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }));
  return { app, store, operations: () => [...store.values()].filter((value) => value.kind === "gateway-vm"), audits: () => [...store.values()].filter((value) => value.recordType === "audit") };
}
const livePath = `/gateways/${GATEWAY}/computer/replace`;
const parkedPath = `/customers/${OWNER}/computer/replace`;

describe("admin computer replacement", () => {
  it.each([livePath, parkedPath])("rejects unavailable replacement before admission: %s", async (path) => {
    const h = harness({}, "admin", false);
    const result = await request(h.app).post(path).send({}).expect(409);
    expect(result.body.error).toContain("unavailable in this release");
    expect(h.audits()).toHaveLength(0);
    expect(h.operations()).toHaveLength(0);
  });
  it("journals and enqueues only checkpoint-gated replacement for the currently bound VM", async () => {
    const h = harness();
    const res = await request(h.app).post(livePath).set("Idempotency-Key", "one-replacement").send({}).expect(202);
    expect(res.body.operationId).toBeTruthy();
    expect(h.operations()).toEqual([expect.objectContaining({ kind: "gateway-vm", status: "pending", createdBy: "operator", gatewayId: GATEWAY, inputUid: OWNER, input: { gatewayId: GATEWAY, uid: OWNER, action: "replace" } })]);
    expect(h.audits()).toEqual([expect.objectContaining({ actor: "operator", status: "completed", mutation: { kind: "replace-computer", gatewayId: GATEWAY } })]);
    expect(h.store.get(`glmGateways/${GATEWAY}`)?.vm).toEqual(vm);
    await request(h.app).post(livePath).set("Idempotency-Key", "one-replacement").send({}).expect(409);
    expect(h.operations()).toHaveLength(1);
  });
  it.each([["anonymous", 401], ["member", 403]])("rejects %s before journaling or reading a computer", async (role, status) => {
    const h = harness({}, role as string);
    await request(h.app).post(livePath).send({}).expect(status as number);
    expect(h.audits()).toHaveLength(0);
    expect(h.operations()).toHaveLength(0);
  });
  it.each([{ action: "delete" }, { ownerUid: "someone-else" }, { force: true }, []])("rejects caller-controlled target or destructive flags %j", async (body) => {
    const h = harness();
    await request(h.app).post(livePath).send(body).expect(400);
    expect(h.operations()).toHaveLength(0);
  });
  it.each([
    { [`gateways/${GATEWAY}`]: null },
    { [`gateways/${GATEWAY}`]: { ...gateway, desiredStatus: "retired" } },
    { [`gateways/${GATEWAY}`]: { ...gateway, retirementClaim: { claimedAt: 1 } } },
    { [`users/${OWNER}`]: null },
    { [`gateways/${GATEWAY}`]: { ...gateway, gatewayClass: "shared", ownerUid: null, builderSlug: null } },
    { [`glmGateways/${GATEWAY}`]: { runtime: "k8s-pod", vm } },
    { [`glmGateways/${GATEWAY}`]: { runtime: "gce-vm", vm: null } },
    { [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "b-other" } } } },
  ])("does not enqueue invalid or no-longer-owned computers %j", async (overrides) => {
    const h = harness(overrides);
    const res = await request(h.app).post(livePath).send({});
    expect([404, 409]).toContain(res.status);
    expect(h.operations()).toHaveLength(0);
  });
  it.each(["/gateways/invalid%2Fgateway/computer/replace", "/customers/invalid%2Fowner/computer/replace"])("rejects malformed document identities %s before journaling", async (path) => {
    const h = harness();
    await request(h.app).post(path).send({}).expect(400);
    expect(h.audits()).toHaveLength(0);
    expect(h.operations()).toHaveLength(0);
  });
  it("permits a paused VM whose handler will start it for the final checkpoint", async () => {
    const h = harness({ [`gateways/${GATEWAY}`]: { ...gateway, desiredStatus: "paused" } });
    await request(h.app).post(livePath).send({}).expect(202);
    expect(h.operations()).toHaveLength(1);
  });
  it("serializes concurrent replacement admission and rejects a conflicting owner operation", async () => {
    const h = harness();
    const responses = await Promise.all([request(h.app).post(livePath).send({}), request(h.app).post(livePath).send({})]);
    expect(responses.map((res) => res.status).sort()).toEqual([202, 409]);
    expect(h.operations()).toHaveLength(1);
    const busy = harness({ "glmOperations/migration": { status: "running", kind: "migrate-customer", inputUid: OWNER, input: { uid: OWNER } } });
    await request(busy.app).post(livePath).send({}).expect(409);
    expect(busy.operations()).toHaveLength(0);
    expect(busy.audits()).toEqual([expect.objectContaining({ status: "failed", error: expect.stringContaining("computer operation already in flight") })]);
  });
  it("journals parked replacement using the owner binding and fresh park checkpoint", async () => {
    const h = harness({ [`glmGateways/${GATEWAY}`]: { runtime: "gce-vm", vm: null }, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: parked } } });
    await request(h.app).post(parkedPath).send({}).expect(202);
    expect(h.operations()).toEqual([expect.objectContaining({ inputUid: OWNER, input: { ownerUid: OWNER, uid: OWNER, action: "replace" } })]);
  });
  it("journals explicit force recovery for an owner with a stale checkpoint", async () => {
    const stale = { ...parked, checkpoint: { ...parked.checkpoint, outcome: "stale" } };
    const h = harness({ [`gateways/${GATEWAY}`]: null, [`glmGateways/${GATEWAY}`]: { runtime: "gce-vm", vm: null }, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: stale } } });
    const res = await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    expect(h.operations()).toEqual([expect.objectContaining({ input: { ownerUid: OWNER, uid: OWNER, action: "replace", force: true, expectedGatewayId: GATEWAY, expectedInstanceId: "123" } })]);
    expect(h.audits()).toEqual([expect.objectContaining({ forced: true, mutation: expect.objectContaining({ kind: "replace-computer", force: true }) })]);
    expect(h.store.get(`users/${OWNER}`)).toHaveProperty("provisioning.computerRecovery.operationId", res.body.operationId);
  });
  it.each(["requested", "provisioning", "activating", "active", "returning"])("refuses force recovery while activation is %s", async status => {
    const h = harness({ [`gateways/${GATEWAY}`]: null, [`glmGateways/${GATEWAY}`]: null, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a", activationLease: { status } }, computer: parked } } });
    await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(409);
    expect(h.operations()).toHaveLength(0);
  });
  it("does not fence an owner when the parked computer has no instance ID", async () => {
    const h = harness({ [`gateways/${GATEWAY}`]: null, [`glmGateways/${GATEWAY}`]: null, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: { ...parked, instanceId: null } } } });
    await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(409);
    expect(h.store.get(`users/${OWNER}`)).not.toHaveProperty("provisioning.computerRecovery");
    expect(h.operations()).toHaveLength(0);
  });
  it("does not fence an owner when the old gateway is running or belongs to another tenant", async () => {
    for (const root of [gateway, { ...gateway, desiredStatus: "paused", ownerUid: "other" }]) {
      const h = harness({ [`gateways/${GATEWAY}`]: root, [`glmGateways/${GATEWAY}`]: null, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: parked } } });
      await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(409);
      expect(h.store.get(`users/${OWNER}`)).not.toHaveProperty("provisioning.computerRecovery");
    }
  });
  it.each([["anonymous", 401], ["member", 403]])("refuses %s force recovery", async (role, status) => {
    const h = harness({}, role as string);
    await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(status as number);
    expect(h.operations()).toHaveLength(0);
  });
  it("retries the same fenced operation after failure even if the parked record was already cleared", async () => {
    const h = harness({ [`gateways/${GATEWAY}`]: null, [`glmGateways/${GATEWAY}`]: null, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: parked } } });
    const first = await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    const operation = h.store.get(`glmOperations/${first.body.operationId}`)!;
    operation.status = "failed";
    h.store.set("glmOperations/pending-migration", { status: "pending", kind: "migrate-customer", inputUid: OWNER, input: { uid: OWNER } });
    const owner = h.store.get(`users/${OWNER}`)!;
    delete (owner.provisioning as Record<string, unknown>).computer;
    const retried = await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    expect(retried.body.operationId).toBe(first.body.operationId);
    expect(operation.status).toBe("pending");
    expect(h.operations()).toHaveLength(1);
  });
  it("does not rearm a changed operation behind a recovery fence", async () => {
    const h = harness({ [`gateways/${GATEWAY}`]: null, [`glmGateways/${GATEWAY}`]: null, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: parked } } });
    const first = await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    const operation = h.store.get(`glmOperations/${first.body.operationId}`)!;
    operation.status = "failed";
    (operation.input as Record<string, unknown>).expectedInstanceId = "other";
    await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(409);
    expect(operation.status).toBe("failed");
  });
  it("recreates an expired failed operation with the pinned identity", async () => {
    const h = harness({ [`gateways/${GATEWAY}`]: null, [`glmGateways/${GATEWAY}`]: null, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: parked } } });
    const first = await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    h.store.delete(`glmOperations/${first.body.operationId}`);
    const retry = await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    expect(retry.body.operationId).toBe(first.body.operationId);
    expect(h.operations()).toEqual([expect.objectContaining({ status: "pending", input: expect.objectContaining({ ownerUid: OWNER, expectedGatewayId: GATEWAY, expectedInstanceId: "123" }) })]);
  });
  it("refreshes a failed recovery's serving Shared epoch before retry", async () => {
    const h = harness({ [`gateways/${GATEWAY}`]: null, [`glmGateways/${GATEWAY}`]: null, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: parked } } });
    const first = await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    h.store.get(`glmOperations/${first.body.operationId}`)!.status = "failed";
    h.store.get(`gateways/shared-a/assignments/${OWNER}`)!.epoch = 2;
    await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    expect(h.store.get(`users/${OWNER}`)).toHaveProperty("provisioning.computerRecovery.assignmentEpoch", 2);
  });
  it.each([{ force: true }, { acceptBootDataLoss: true }, { force: false, acceptBootDataLoss: true }])("requires both force and explicit boot data loss acknowledgement: %j", async body => {
    const h = harness();
    await request(h.app).post(parkedPath).send(body).expect(400);
    expect(h.operations()).toHaveLength(0);
  });
  it.each([
    { provisioning: {} },
    { provisioning: { computer: { ...parked, checkpoint: { ...parked.checkpoint, outcome: "stale" } } } },
  ])("refuses parked replacement without a fresh checkpoint %j", async (user) => {
    const h = harness({ [`users/${OWNER}`]: user });
    const res = await request(h.app).post(parkedPath).send({});
    expect([404, 409]).toContain(res.status);
    expect(h.operations()).toHaveLength(0);
  });
  it("refuses the parked-owner route while that computer is still bound to a gateway", async () => {
    const h = harness({ [`users/${OWNER}`]: { provisioning: { computer: parked } } });
    await request(h.app).post(parkedPath).send({}).expect(409);
    expect(h.operations()).toHaveLength(0);
  });
});
