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
  ownerUid: OWNER, builderSlug: "fixture", openclawOverrides: null, modelBrokerLimits: null,
};
const vm = { instanceName: "octo-fixture", zone: "us-central1-a", instanceId: "123", status: "RUNNING" };
const parked = { ...vm, gatewayId: GATEWAY, parkedAt: 100, checkpoint: { outcome: "fresh", requestedAt: 90, completedAt: 95 } };

function harness(overrides: Record<string, Record<string, unknown> | null> = {}, role = "admin") {
  const store = new Map<string, Record<string, unknown>>(Object.entries({
    [`gateways/${GATEWAY}`]: gateway,
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
          update: (ref: { path: string }, value: Record<string, unknown>) => writes.push(() => store.set(ref.path, { ...store.get(ref.path), ...value })),
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
  addAdminFleetRoutes(app, { db, logger: { info: vi.fn(), warn: vi.fn() }, workspaceSlugsForUser: () => ["fixture"], provisionGatewayAuthSecret: vi.fn(), listGatewayBuilds: vi.fn(), suspendAuthUser: vi.fn(), revokeConnectorGrantsForUser: vi.fn() });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }));
  return { app, store, operations: () => [...store.values()].filter((value) => value.kind === "gateway-vm"), audits: () => [...store.values()].filter((value) => value.recordType === "audit") };
}
const livePath = `/gateways/${GATEWAY}/computer/replace`;
const parkedPath = `/customers/${OWNER}/computer/replace`;

describe("admin computer replacement", () => {
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
