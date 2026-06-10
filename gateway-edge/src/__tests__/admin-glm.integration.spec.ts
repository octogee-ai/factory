import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FirestoreCall {
  collection: string;
  op: "add" | "doc.set" | "doc.update" | "batch.commit";
  docId?: string;
  data?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

let batchCommitFailures = 0;

const calls: FirestoreCall[] = [];
let glmOperationsDocs: Array<{ id: string; data: Record<string, unknown> }> = [];
let glmGatewaysDocs: Record<string, Record<string, unknown>> = {};
let gatewaysDocs: Record<string, Record<string, unknown>> = {};
let usersDocs: Record<string, Record<string, unknown>> = {};
let operatorGatewayReservationsDocs: Record<string, Record<string, unknown>> = {};
let restoreJobsDocs: Array<{ id: string; data: Record<string, unknown> }> = [];

function readNestedField(data: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = data;
  for (const part of path.split(".")) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

vi.mock("../lib/db", () => {
  function whereChain(
    collectionName: string,
    filter?: { field: string; value: unknown },
  ) {
    return {
      orderBy: () => whereChain(collectionName, filter),
      limit: () => whereChain(collectionName, filter),
      where: (field: string, _op: string, value: unknown) =>
        whereChain(collectionName, { field, value }),
      get: async () => {
        if (collectionName === "glmOperations") {
          const docs = filter
            ? glmOperationsDocs.filter((d) => {
                const v = d.data[filter.field];
                if (Array.isArray(filter.value)) {
                  return (filter.value as unknown[]).includes(v);
                }
                return v === filter.value;
              })
            : glmOperationsDocs;
          return {
            docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
            size: docs.length,
          };
        }
        if (collectionName === "glmGateways" && filter) {
          const matches = Object.entries(glmGatewaysDocs)
            .filter(([, data]) => data[filter.field] === filter.value)
            .map(([id, data]) => ({ id, data: () => data }));
          return { docs: matches, size: matches.length };
        }
        if (collectionName === "glmGateways" && !filter) {
          const docs = Object.entries(glmGatewaysDocs).map(([id, data]) => ({ id, data: () => data }));
          return { docs, size: docs.length };
        }
        if (collectionName === "restoreJobs") {
          return {
            docs: restoreJobsDocs.map((d) => ({ id: d.id, data: () => d.data })),
            size: restoreJobsDocs.length,
          };
        }
        if (collectionName === "users" && filter) {
          const matches = Object.entries(usersDocs)
            .filter(([, data]) => readNestedField(data, filter.field) === filter.value)
            .map(([id, data]) => ({ id, data: () => data }));
          return { docs: matches, size: matches.length };
        }
        if (collectionName === "users" && !filter) {
          const docs = Object.entries(usersDocs).map(([id, data]) => ({
            id,
            data: () => data,
          }));
          return { docs, size: docs.length };
        }
        return { docs: [], size: 0 };
      },
    };
  }

  function makeDocRef(name: string, docId: string): any {
    return {
      id: docId,
      _collection: name,
      get: async () => {
        if (name === "glmGateways") {
          const data = glmGatewaysDocs[docId];
          return { exists: data !== undefined, data: () => data };
        }
        if (name === "gateways") {
          const data = gatewaysDocs[docId];
          return { exists: data !== undefined, data: () => data };
        }
        if (name === "users") {
          const data = usersDocs[docId];
          return { exists: data !== undefined, data: () => data };
        }
        if (name === "operatorGatewayReservations") {
          const data = operatorGatewayReservationsDocs[docId];
          return { exists: data !== undefined, data: () => data };
        }
        return { exists: true, data: () => ({}) };
      },
      set: async (data: Record<string, unknown>, options?: Record<string, unknown>) => {
        calls.push({ collection: name, op: "doc.set", docId, data, options });
        if (name === "glmGateways") glmGatewaysDocs[docId] = data;
        if (name === "glmOperations") glmOperationsDocs.unshift({ id: docId, data });
        if (name === "users") usersDocs[docId] = data;
        if (name === "operatorGatewayReservations") operatorGatewayReservationsDocs[docId] = data;
      },
      update: async (data: Record<string, unknown>) => {
        calls.push({ collection: name, op: "doc.update", docId, data });
        if (name === "glmGateways" && glmGatewaysDocs[docId]) {
          glmGatewaysDocs[docId] = { ...glmGatewaysDocs[docId], ...data };
        }
        if (name === "users" && usersDocs[docId]) {
          usersDocs[docId] = { ...usersDocs[docId], ...data };
        }
        if (name === "operatorGatewayReservations" && operatorGatewayReservationsDocs[docId]) {
          operatorGatewayReservationsDocs[docId] = { ...operatorGatewayReservationsDocs[docId], ...data };
        }
      },
    };
  }

  function collection(name: string): any {
    return {
      add: async (data: Record<string, unknown>) => {
        const id = `doc-${calls.length}`;
        calls.push({ collection: name, op: "add", docId: id, data });
        if (name === "glmOperations") glmOperationsDocs.unshift({ id, data });
        return { id };
      },

doc: (docId?: string) => {
        const id = docId ?? `auto-${calls.length}-${name}`;
        return makeDocRef(name, id);
      },
      orderBy: () => whereChain(name),
      where: (field: string, _op: string, value: unknown) =>
        whereChain(name, { field, value }),
      limit: () => whereChain(name),
      get: async () => {
        if (name === "gateways") {
          const docs = Object.entries(gatewaysDocs).map(([id, data]) => ({
            id,
            data: () => data,
          }));
          return { docs, size: docs.length };
        }
        if (name === "users") {
          const docs = Object.entries(usersDocs).map(([id, data]) => ({
            id,
            data: () => data,
          }));
          return { docs, size: docs.length };
        }
        if (name === "glmGateways") {
          const docs = Object.entries(glmGatewaysDocs).map(([id, data]) => ({
            id,
            data: () => data,
          }));
          return { docs, size: docs.length };
        }
        if (name === "operatorGatewayReservations") {
          const docs = Object.entries(operatorGatewayReservationsDocs).map(([id, data]) => ({
            id,
            data: () => data,
          }));
          return { docs, size: docs.length };
        }
        return { docs: [], size: 0 };
      },
    };
  }

function makeBatch() {
    const pending: Array<() => Promise<void>> = [];
    return {
      update(docRef: any, data: Record<string, unknown>) {
        pending.push(() => docRef.update(data));
        return this;
      },
      set(docRef: any, data: Record<string, unknown>, options?: Record<string, unknown>) {
        pending.push(() => docRef.set(data, options));
        return this;
      },
      delete(docRef: any) {
        pending.push(() => docRef.delete?.());
        return this;
      },
      commit: async () => {
        if (batchCommitFailures > 0) {
          batchCommitFailures -= 1;
          throw new Error("simulated batch commit failure");
        }
        for (const fn of pending) await fn();
        calls.push({ collection: "<batch>", op: "batch.commit" });
      },
    };
  }

  return {
    db: {
      collection,
      batch: () => makeBatch(),
      doc: (path: string) => {
        const [coll, id] = path.split("/");
        return {
          id,
          get: async () => ({ exists: true, data: () => ({}) }),
          set: async (data: Record<string, unknown>) => {
            calls.push({ collection: coll, op: "doc.set", docId: id, data });
          },
          update: async (data: Record<string, unknown>) => {
            calls.push({ collection: coll, op: "doc.update", docId: id, data });
          },
        };
      },
      getAll: async () => [],
    },
    FieldValue: { serverTimestamp: () => "now" },
    Timestamp: { now: () => ({ toDate: () => new Date() }) },
  };
});

const provisionerCalls: Array<{ gatewayId: string; gatewayServiceAccount: string }> = [];
let provisionerNextError: Error | null = null;

vi.mock("../../../scripts/lib/secret-manager", () => ({
  provisionGatewayAuthSecret: async (params: {
    gatewayId: string;
    gatewayServiceAccount: string;
  }) => {
    if (provisionerNextError) {
      const e = provisionerNextError;
      provisionerNextError = null;
      throw e;
    }
    provisionerCalls.push(params);
    return { secretName: `projects/octogee-test/secrets/gateway-auth-token-${params.gatewayId}`, created: true };
  },
}));

type BuildResult = { tag: string; pushedAt: string; digest: string };
const builderCalls: Array<{ service: string; limit?: number }> = [];
let nextBuildsResult: BuildResult[] = [];
let nextBuildsError: Error | null = null;

vi.mock("../../../scripts/lib/artifact-registry", () => ({
  listGatewayBuilds: async (opts: { service: string; limit?: number }) => {
    builderCalls.push({ service: opts.service, limit: opts.limit });
    if (nextBuildsError) {
      const e = nextBuildsError;
      nextBuildsError = null;
      throw e;
    }
    return nextBuildsResult;
  },
}));

vi.mock("../middleware/auth", () => ({

  requireAdmin: (req: any, _res: any, next: any) => {
    req.uid = "admin-user";
    req.user = { email: "admin@octogee.com" };
    next();
  },
  requireAuth: (req: any, _res: any, next: any) => {
    req.uid = "admin-user";
    req.user = usersDocs["admin-user"] ?? { email: "admin@octogee.com" };
    next();
  },
}));

import express from "express";
import adminRouter from "../routes/admin.js";
import operatorReservationRouter from "../routes/billing/operator-reservation.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return app;
}

function buildOperatorFlowApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/billing", operatorReservationRouter);
  app.use("/api/admin", adminRouter);
  return app;
}

beforeEach(() => {
  calls.length = 0;
  glmOperationsDocs = [];
  glmGatewaysDocs = {};
  gatewaysDocs = { "canary": { gatewayId: "canary", status: "ready" } };
  usersDocs = {};
  operatorGatewayReservationsDocs = {};
  restoreJobsDocs = [];
  provisionerCalls.length = 0;
  provisionerNextError = null;
  builderCalls.length = 0;
  nextBuildsResult = [];
  nextBuildsError = null;
  batchCommitFailures = 0;
  process.env.GATEWAY_SERVICE_ACCOUNT = "octogee-gateway@octogee-test.iam.gserviceaccount.com";
});

describe("POST /api/admin/gateways — create desired state + op", () => {
  it("writes a glmGateways doc and creates an add-gateway operation", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "canary",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ gatewayId: "canary" });
    expect(res.body.operationId).toBeTruthy();

    const gwWrite = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.set",
    );
    expect(gwWrite?.docId).toBe("canary");
    expect(gwWrite?.data).toMatchObject({
      gatewayId: "canary",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
      desiredStatus: "running",
      createdBy: "admin-user",
    });

    const opWrite = calls.find((c) => c.collection === "glmOperations");
    expect(opWrite?.data).toMatchObject({
      kind: "add-gateway",
      status: "pending",
      createdBy: "admin-user",
      gatewayId: "canary",
    });
  });

  it("rejects bodies missing required fields with 400", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({ gatewayId: "x" });
    expect(res.status).toBe(400);
  });

  it("persists sizingTier and profile when supplied in the body", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "canary",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
      profile: "operator",
      sizingTier: "large",
    });
    expect(res.status).toBe(202);
    const gwWrite = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.set",
    );
    expect(gwWrite?.data).toMatchObject({
      profile: "operator",
      sizingTier: "large",
      persistence: {
        enabled: true,
        storageClassName: "premium-rwo",
        size: "20Gi",
        accessModes: ["ReadWriteOnce"],
      },
      operatorAccess: {
        shellsEnabled: false,
        reason: "operator-trust-boundary-not-provisioned",
      },
      serviceAccountName: "octogee-gw-canary",
      serviceAccount: {
        create: true,
      },
    });
  });

  it("reserves an operator gateway for a real owner without enabling shells", async () => {
    usersDocs["uid-jack"] = {
      username: "jack",
      provisioning: { openclaw: { slug: "jack" } },
    };
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "jack",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
      profile: "operator",
      ownerUid: "uid-jack",
    });
    expect(res.status).toBe(202);

    const gwWrite = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.set",
    );
    expect(gwWrite?.data).toMatchObject({
      gatewayId: "jack",
      profile: "operator",
      ownerUid: "uid-jack",
      builderSlug: "jack",
      operatorAccess: {
        shellsEnabled: false,
        reason: "operator-trust-boundary-not-provisioned",
      },
      operatorReservation: {
        status: "reserved",
        reservedBy: "admin-user",
        billingStatus: "manual",
      },
    });
    expect(typeof gwWrite?.data?.operatorReservation).toBe("object");
    expect(typeof (gwWrite?.data?.operatorReservation as { reservedAt?: unknown }).reservedAt).toBe("number");

    const opWrite = calls.find((c) => c.collection === "glmOperations");
    expect(opWrite?.data?.input).toMatchObject({
      gatewayId: "jack",
      profile: "operator",
      ownerUid: "uid-jack",
      builderSlug: "jack",
    });
  });

  it("rejects reservation fields on non-operator gateways before side effects", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "canary",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
      ownerUid: "uid-jack",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/profile=operator/);
    expect(provisionerCalls).toEqual([]);
    const gwWrite = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.set",
    );
    expect(gwWrite).toBeUndefined();
  });

  it("rejects reservations for missing owner users before provisioning gateway auth", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "ghost",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
      profile: "operator",
      ownerUid: "uid-ghost",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/owner user/i);
    expect(provisionerCalls).toEqual([]);
    const gwWrite = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.set",
    );
    expect(gwWrite).toBeUndefined();
  });

  it("rejects unknown sizingTier values on create with 400", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "canary",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
      sizingTier: "bogus-tier",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sizingTier/);
    const gwWrite = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.set",
    );
    expect(gwWrite).toBeUndefined();
  });

  it("provisions the gateway-auth-token Secret Manager shell (+ IAM) before writing the glmGateways doc", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "canary",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
    });
    expect(res.status).toBe(202);
    expect(provisionerCalls).toEqual([
      {
        gatewayId: "canary",
        gatewayServiceAccount: "octogee-gateway@octogee-test.iam.gserviceaccount.com",
      },
    ]);
  });

  it("does NOT write the glmGateways doc if SM provisioning fails — operator gets 502 with detail", async () => {
    provisionerNextError = new Error("PERMISSION_DENIED on secretmanager.secrets.create");
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "canary",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/auth-token/);
    const gwWrite = calls.find((c) => c.collection === "glmGateways" && c.op === "doc.set");
    expect(gwWrite).toBeUndefined();
  });

  it("returns 500 if GATEWAY_SERVICE_ACCOUNT is not configured (cluster misconfigured)", async () => {
    delete process.env.GATEWAY_SERVICE_ACCOUNT;
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "canary",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
    });
    expect(res.status).toBe(500);
    expect(provisionerCalls).toEqual([]);
  });

  it("rejects 400 when imageRepository is not the canonical Artifact Registry repo", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "typo",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogeee/octogee-gateway",
      imageTag: "abc1234",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/imageRepository/i);
  });

  it("returns 409 when the gatewayId already exists", async () => {
    glmGatewaysDocs["gw-existing"] = {
      gatewayId: "gw-existing",
    };
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "gw-existing",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "v1",
    });
    expect(res.status).toBe(409);
  });

});

describe("GET /api/admin/operator-gateway-reservations", () => {
  it("returns reservations sorted by fulfillment priority with ISO timestamps", async () => {
    operatorGatewayReservationsDocs["uid-pending"] = {
      uid: "uid-pending",
      builderSlug: "pending",
      requestedSizingTier: "large",
      status: "billing_pending",
      billingStatus: "pending",
      currentGatewayId: "default",
      currentGatewayProfile: "standard",
      requestedAt: 2_000,
      updatedAt: 9_000,
    };
    operatorGatewayReservationsDocs["uid-ready"] = {
      uid: "uid-ready",
      builderSlug: "ready",
      requestedSizingTier: "medium",
      status: "requested",
      billingStatus: "active",
      currentGatewayId: "default",
      currentGatewayProfile: "standard",
      requestedAt: 1_000,
      updatedAt: 1_000,
    };
    operatorGatewayReservationsDocs["uid-provisioning"] = {
      uid: "uid-provisioning",
      builderSlug: "provisioning",
      requestedSizingTier: "medium",
      status: "provisioning",
      billingStatus: "active",
      currentGatewayId: "default",
      currentGatewayProfile: "standard",
      gatewayId: "provisioning",
      operationId: "op-1",
      provisioningStartedAt: 3_000,
      provisioningStartedBy: "admin-user",
      requestedAt: 3_000,
      updatedAt: 8_000,
    };

    const app = buildApp();
    const res = await request(app).get("/api/admin/operator-gateway-reservations");

    expect(res.status).toBe(200);
    expect(res.body.reservations.map((r: { uid: string }) => r.uid)).toEqual([
      "uid-ready",
      "uid-pending",
      "uid-provisioning",
    ]);
    expect(res.body.reservations[0]).toMatchObject({
      uid: "uid-ready",
      builderSlug: "ready",
      requestedSizingTier: "medium",
      status: "requested",
      billingStatus: "active",
      currentGatewayId: "default",
      currentGatewayProfile: "standard",
      requestedAt: new Date(1_000).toISOString(),
      updatedAt: new Date(1_000).toISOString(),
      readyToFulfill: true,
      fulfillBlockedReason: null,
    });
    expect(res.body.reservations[1]).toMatchObject({
      uid: "uid-pending",
      readyToFulfill: false,
      fulfillBlockedReason: "status is billing_pending",
    });
    expect(res.body.reservations[2]).toMatchObject({
      uid: "uid-provisioning",
      gatewayId: "provisioning",
      operationId: "op-1",
      provisioningStartedAt: new Date(3_000).toISOString(),
      provisioningStartedBy: "admin-user",
    });
    expect(typeof res.body.generatedAt).toBe("string");
  });
});

describe("operator reservation request → Cowboy fulfillment integration", () => {
  it("lets request-stage reservations update sizing without resetting requestedAt", async () => {
    usersDocs["admin-user"] = {
      username: "alice",
      email: "alice@example.com",
      subscription: { status: "active" },
      provisioning: {
        openclaw: {
          slug: "alice",
          gatewayId: "default",
          gatewayProfile: "standard",
        },
      },
    };
    operatorGatewayReservationsDocs["admin-user"] = {
      uid: "admin-user",
      builderSlug: "alice",
      requestedSizingTier: "small",
      status: "billing_pending",
      billingStatus: "pending",
      currentGatewayId: "default",
      currentGatewayProfile: "standard",
      requestedAt: 1_234,
      updatedAt: 1_234,
    };
    const app = buildOperatorFlowApp();

    const res = await request(app)
      .post("/api/billing/operator-gateway/reservation")
      .send({ sizingTier: "large" });

    expect(res.status).toBe(202);
    expect(res.body.reservation).toMatchObject({
      uid: "admin-user",
      requestedSizingTier: "large",
      status: "requested",
      billingStatus: "active",
      requestedAt: 1_234,
      currentGatewayId: "default",
      currentGatewayProfile: "standard",
    });
    expect(operatorGatewayReservationsDocs["admin-user"]).toMatchObject({
      requestedSizingTier: "large",
      status: "requested",
      billingStatus: "active",
      requestedAt: 1_234,
    });
  });

  it("rejects customer updates once a reservation is provisioning", async () => {
    usersDocs["admin-user"] = {
      username: "alice",
      email: "alice@example.com",
      subscription: { status: "active" },
      provisioning: {
        openclaw: {
          slug: "alice",
          gatewayId: "default",
          gatewayProfile: "standard",
        },
      },
    };
    operatorGatewayReservationsDocs["admin-user"] = {
      uid: "admin-user",
      builderSlug: "alice",
      requestedSizingTier: "large",
      status: "provisioning",
      billingStatus: "active",
      currentGatewayId: "default",
      currentGatewayProfile: "standard",
      gatewayId: "alice",
      operationId: "op-add",
      requestedAt: 1_234,
      updatedAt: 2_345,
    };
    const before = { ...operatorGatewayReservationsDocs["admin-user"] };
    const app = buildOperatorFlowApp();

    const res = await request(app)
      .post("/api/billing/operator-gateway/reservation")
      .send({ sizingTier: "small" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "operator gateway reservation can no longer be updated",
      status: "provisioning",
      gatewayId: "alice",
    });
    expect(operatorGatewayReservationsDocs["admin-user"]).toEqual(before);
    expect(calls.find((c) => c.collection === "operatorGatewayReservations")).toBeUndefined();
  });

  it("surfaces an active customer request in Cowboy and fulfills a locked operator gateway without moving the user", async () => {
    usersDocs["admin-user"] = {
      username: "alice",
      email: "alice@example.com",
      subscription: { status: "active" },
      provisioning: {
        openclaw: {
          slug: "alice",
          gatewayId: "default",
          gatewayProfile: "standard",
        },
      },
    };
    const app = buildOperatorFlowApp();

    const requestRes = await request(app)
      .post("/api/billing/operator-gateway/reservation")
      .send({ sizingTier: "large" });
    expect(requestRes.status).toBe(202);
    expect(requestRes.body.reservation).toMatchObject({
      uid: "admin-user",
      builderSlug: "alice",
      requestedSizingTier: "large",
      status: "requested",
      billingStatus: "active",
      currentGatewayId: "default",
      currentGatewayProfile: "standard",
    });

    const queueRes = await request(app).get("/api/admin/operator-gateway-reservations");
    expect(queueRes.status).toBe(200);
    expect(queueRes.body.reservations).toHaveLength(1);
    expect(queueRes.body.reservations[0]).toMatchObject({
      uid: "admin-user",
      builderSlug: "alice",
      requestedSizingTier: "large",
      readyToFulfill: true,
      fulfillBlockedReason: null,
    });

    const fulfillRes = await request(app)
      .post("/api/admin/operator-gateway-reservations/admin-user/fulfill")
      .send({
        gatewayId: "alice",
        imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
        imageTag: "abc1234",
      });
    expect(fulfillRes.status).toBe(202);
    expect(fulfillRes.body).toMatchObject({
      uid: "admin-user",
      gatewayId: "alice",
      status: "provisioning",
    });

    const gwWrite = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.set",
    );
    expect(gwWrite?.data).toMatchObject({
      gatewayId: "alice",
      profile: "operator",
      ownerUid: "admin-user",
      builderSlug: "alice",
      sizingTier: "large",
      operatorAccess: {
        shellsEnabled: false,
        reason: "operator-trust-boundary-not-provisioned",
      },
      serviceAccountName: "octogee-gw-alice",
      serviceAccount: { create: true },
      persistence: {
        enabled: true,
        storageClassName: "premium-rwo",
        size: "20Gi",
        accessModes: ["ReadWriteOnce"],
      },
    });

    const userUpdates = calls.filter(
      (c) => c.collection === "users" && c.op === "doc.update",
    );
    const fulfillmentUserUpdate = userUpdates[userUpdates.length - 1];
    expect(fulfillmentUserUpdate?.docId).toBe("admin-user");
    expect(fulfillmentUserUpdate?.data).toMatchObject({
      "operatorGatewayReservation.status": "provisioning",
      "operatorGatewayReservation.gatewayId": "alice",
    });
    expect(fulfillmentUserUpdate?.data).not.toHaveProperty(
      "provisioning.openclaw.gatewayId",
    );
    expect(fulfillmentUserUpdate?.data).not.toHaveProperty(
      "provisioning.openclaw.shellsEnabled",
    );

    gatewaysDocs["alice"] = {
      gatewayId: "alice",
      status: "ready",
      mountedCustomers: [],
    };
    const activateRes = await request(app)
      .post("/api/admin/operator-gateway-reservations/admin-user/activate")
      .send({});
    expect(activateRes.status).toBe(202);
    expect(activateRes.body).toMatchObject({
      uid: "admin-user",
      gatewayId: "alice",
      status: "activating",
    });
    const activationOp = calls
      .filter((c) => c.collection === "glmOperations" && c.op === "doc.set")
      .at(-1);
    expect(activationOp?.data).toMatchObject({
      kind: "migrate-customer",
      status: "pending",
      createdBy: "admin-user",
      gatewayId: "alice",
      inputUid: "admin-user",
      input: {
        uid: "admin-user",
        toGatewayId: "alice",
        source: "operator-gateway-reservation",
        operatorReservationUid: "admin-user",
        builderSlug: "alice",
      },
    });
    const activationReservationUpdate = calls
      .filter(
        (c) => c.collection === "operatorGatewayReservations" && c.op === "doc.update",
      )
      .at(-1);
    expect(activationReservationUpdate?.data).toMatchObject({
      activationOperationId: activateRes.body.operationId,
      activationStartedBy: "admin-user",
    });
  });
});

describe("POST /api/admin/operator-gateway-reservations/:uid/fulfill", () => {
  function seedReadyReservation() {
    usersDocs["uid-alice"] = {
      username: "alice",
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
      subscription: { status: "active" },
    };
    operatorGatewayReservationsDocs["uid-alice"] = {
      uid: "uid-alice",
      builderSlug: "alice",
      requestedSizingTier: "medium",
      status: "requested",
      billingStatus: "active",
      currentGatewayId: "default",
      currentGatewayProfile: "standard",
      requestedAt: 1_234,
      updatedAt: 1_234,
    };
  }

  const fulfillBody = {
    gatewayId: "alice",
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    imageTag: "abc1234",
  };

  it("creates a locked operator gateway desired state from a ready reservation", async () => {
    seedReadyReservation();
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/operator-gateway-reservations/uid-alice/fulfill")
      .send(fulfillBody);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      uid: "uid-alice",
      gatewayId: "alice",
      status: "provisioning",
    });
    expect(res.body.operationId).toBeTruthy();
    expect(provisionerCalls).toEqual([
      {
        gatewayId: "alice",
        gatewayServiceAccount: "octogee-gateway@octogee-test.iam.gserviceaccount.com",
      },
    ]);

    const gwWrite = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.set",
    );
    expect(gwWrite?.docId).toBe("alice");
    expect(gwWrite?.data).toMatchObject({
      gatewayId: "alice",
      imageTag: "abc1234",
      desiredStatus: "running",
      profile: "operator",
      ownerUid: "uid-alice",
      builderSlug: "alice",
      sizingTier: "medium",
      operatorAccess: {
        shellsEnabled: false,
        reason: "operator-trust-boundary-not-provisioned",
      },
      serviceAccountName: "octogee-gw-alice",
      serviceAccount: { create: true },
      persistence: {
        enabled: true,
        storageClassName: "premium-rwo",
        size: "20Gi",
        accessModes: ["ReadWriteOnce"],
      },
      operatorReservation: {
        status: "provisioning",
        reservedAt: 1_234,
        reservedBy: "uid-alice",
        billingStatus: "active",
      },
    });
    expect(typeof (gwWrite?.data?.operatorReservation as { billingVerifiedAt?: unknown }).billingVerifiedAt).toBe("number");

    const reservationUpdate = calls.find(
      (c) => c.collection === "operatorGatewayReservations" && c.op === "doc.update",
    );
    expect(reservationUpdate?.docId).toBe("uid-alice");
    expect(reservationUpdate?.data).toMatchObject({
      status: "provisioning",
      gatewayId: "alice",
      operationId: res.body.operationId,
      provisioningStartedBy: "admin-user",
    });

    const userUpdate = calls.find(
      (c) => c.collection === "users" && c.op === "doc.update",
    );
    expect(userUpdate?.docId).toBe("uid-alice");
    expect(userUpdate?.data).toMatchObject({
      "operatorGatewayReservation.status": "provisioning",
      "operatorGatewayReservation.gatewayId": "alice",
      "operatorGatewayReservation.operationId": res.body.operationId,
    });
    expect(userUpdate?.data).not.toHaveProperty("provisioning.openclaw.gatewayId");
    expect(userUpdate?.data).not.toHaveProperty("provisioning.openclaw.shellsEnabled");

    const opWrite = calls.find((c) => c.collection === "glmOperations");
    expect(opWrite?.docId).toBe(res.body.operationId);
    expect(opWrite?.data).toMatchObject({
      kind: "add-gateway",
      status: "pending",
      createdBy: "admin-user",
      gatewayId: "alice",
      inputUid: "uid-alice",
      input: {
        uid: "uid-alice",
        gatewayId: "alice",
        profile: "operator",
        sizingTier: "medium",
        builderSlug: "alice",
        source: "operator-gateway-reservation",
      },
    });
  });

  it("rejects billing-pending reservations before provisioning gateway auth", async () => {
    seedReadyReservation();
    operatorGatewayReservationsDocs["uid-alice"].status = "billing_pending";
    operatorGatewayReservationsDocs["uid-alice"].billingStatus = "pending";
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/operator-gateway-reservations/uid-alice/fulfill")
      .send(fulfillBody);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not ready/i);
    expect(provisionerCalls).toEqual([]);
    const gwWrite = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.set",
    );
    expect(gwWrite).toBeUndefined();
  });

  it("returns 404 when the reservation request is missing", async () => {
    usersDocs["uid-alice"] = { username: "alice" };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/operator-gateway-reservations/uid-alice/fulfill")
      .send(fulfillBody);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/reservation not found/i);
    expect(provisionerCalls).toEqual([]);
  });

  it("does not update reservation state when gateway auth provisioning fails", async () => {
    seedReadyReservation();
    provisionerNextError = new Error("PERMISSION_DENIED on secretmanager.secrets.create");
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/operator-gateway-reservations/uid-alice/fulfill")
      .send(fulfillBody);

    expect(res.status).toBe(502);
    const reservationUpdate = calls.find(
      (c) => c.collection === "operatorGatewayReservations" && c.op === "doc.update",
    );
    expect(reservationUpdate).toBeUndefined();
    expect(operatorGatewayReservationsDocs["uid-alice"]).toMatchObject({
      status: "requested",
    });
    expect(operatorGatewayReservationsDocs["uid-alice"]).not.toHaveProperty("gatewayId");
  });
});

describe("GET /api/admin/gateways — sizing enrichment", () => {
  it("attaches sizing.tier from glmGateways.sizingTier (explicit) and sizing.resolvedFrom='explicit'", async () => {
    gatewaysDocs["bender"] = { gatewayId: "bender", status: "ready", mountedCustomers: ["alice"] };
    glmGatewaysDocs["bender"] = { gatewayId: "bender", sizingTier: "large", profile: "operator", desiredStatus: "running" };
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    expect(res.status).toBe(200);
    const bender = res.body.gateways.find((g: any) => g.gatewayId === "bender");
    expect(bender.sizing.tier).toBe("large");
    expect(bender.sizing.resolvedFrom).toBe("explicit");
    expect(bender.sizing.resources.requests.cpu).toBe("16000m");
    expect(bender.sizing.monthlyCostUsd.compute).toBeGreaterThan(0);
    expect(bender.desiredStatus).toBe("running");
  });

  it("falls back to profile-default tier when sizingTier is unset (resolvedFrom='profile-default')", async () => {
    gatewaysDocs["default"] = { gatewayId: "default", status: "ready", mountedCustomers: [] };
    glmGatewaysDocs["default"] = { gatewayId: "default", profile: "operator", desiredStatus: "running" };
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    const g = res.body.gateways.find((x: any) => x.gatewayId === "default");
    expect(g.sizing.tier).toBe("small");
    expect(g.sizing.resolvedFrom).toBe("profile-default");
  });

  it("reports compute=0 for paused gateways (no replicas → no node consumption)", async () => {
    for (const k of Object.keys(gatewaysDocs)) delete gatewaysDocs[k];
    gatewaysDocs["paused"] = { gatewayId: "paused", status: "ready", mountedCustomers: [] };
    gatewaysDocs["running"] = { gatewayId: "running", status: "ready", mountedCustomers: [] };
    glmGatewaysDocs["paused"] = { gatewayId: "paused", sizingTier: "large", desiredStatus: "paused" };
    glmGatewaysDocs["running"] = { gatewayId: "running", sizingTier: "large", desiredStatus: "running" };
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    const paused = res.body.gateways.find((g: any) => g.gatewayId === "paused");
    const running = res.body.gateways.find((g: any) => g.gatewayId === "running");
    expect(paused.sizing.tier).toBe("large"); // tier preserved for nameplate display
    expect(paused.sizing.monthlyCostUsd.compute).toBe(0);
    expect(paused.sizing.monthlyCostUsd.perBuilderAtTarget).toBe(0);
    expect(running.sizing.monthlyCostUsd.compute).toBeGreaterThan(0);
    // Fleet roll-up only counts the running gateway's compute.
    expect(res.body.stats.fleetCost.monthlyUsd).toBe(running.sizing.monthlyCostUsd.compute);
  });

  it("rolls up stats.fleetCost.byTier and stats.fleetCost.monthlyUsd across the fleet", async () => {
    // Reset the beforeEach seed so we exercise exactly the two fixtures we set up below.
    for (const k of Object.keys(gatewaysDocs)) delete gatewaysDocs[k];
    gatewaysDocs["bender"] = { gatewayId: "bender", status: "ready", mountedCustomers: [] };
    gatewaysDocs["default"] = { gatewayId: "default", status: "ready", mountedCustomers: [] };
    glmGatewaysDocs["bender"] = { gatewayId: "bender", sizingTier: "large", desiredStatus: "running" };
    glmGatewaysDocs["default"] = { gatewayId: "default", sizingTier: "medium", desiredStatus: "running" };
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    const fc = res.body.stats.fleetCost;
    expect(fc).toBeDefined();
    expect(fc.byTier.large?.count).toBe(1);
    expect(fc.byTier["medium"]?.count).toBe(1);
    expect(fc.monthlyUsd).toBe(fc.byTier.large.subtotalUsd + fc.byTier["medium"].subtotalUsd);
  });
});

describe("PATCH /api/admin/gateways/:id — update desired state", () => {
  it("updates the imageTag field on an existing desired state doc", async () => {
    glmGatewaysDocs["canary"] = { gatewayId: "canary" };
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ imageTag: "def5678" });
    expect(res.status).toBe(202);
    const update = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.update",
    );
    expect(update?.data).toMatchObject({ imageTag: "def5678" });
  });

  it("returns 404 when the gateway does not exist", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/gw-missing")
      .send({ imageTag: "x" });
    expect(res.status).toBe(404);
  });

  it("rejects unknown desiredStatus enum values with 400 (does not write garbage to Firestore)", async () => {
    glmGatewaysDocs["canary"] = { gatewayId: "canary" };
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ desiredStatus: "burning" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/desiredStatus/);
    const update = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.update",
    );
    expect(update).toBeUndefined();
  });

  it("rejects desiredStatus=retired — retirement must go through DELETE for full teardown", async () => {
    glmGatewaysDocs["canary"] = { gatewayId: "canary" };
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ desiredStatus: "retired" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/DELETE \/gateways\/:id/);
    const update = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.update",
    );
    expect(update).toBeUndefined();
  });

  it("accepts desiredStatus=paused for the pause/resume flow", async () => {
    glmGatewaysDocs["canary"] = { gatewayId: "canary" };
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ desiredStatus: "paused" });
    expect(res.status).toBe(202);
    const update = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.update",
    );
    expect(update?.data).toMatchObject({ desiredStatus: "paused" });
  });

  it("updates the sizingTier field when a valid tier is supplied", async () => {
    glmGatewaysDocs["canary"] = { gatewayId: "canary" };
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ sizingTier: "large" });
    expect(res.status).toBe(202);
    const update = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.update",
    );
    expect(update?.data).toMatchObject({ sizingTier: "large" });
  });

  it("rejects unknown sizingTier values with 400 (does not write garbage to Firestore)", async () => {
    glmGatewaysDocs["canary"] = { gatewayId: "canary" };
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ sizingTier: "bogus-tier" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sizingTier/);
    const update = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.update",
    );
    expect(update).toBeUndefined();
  });
});

describe("POST /api/admin/gateways — body type guards", () => {
  it("rejects non-string gatewayId with 400", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: 12345,
      imageRepository:
        "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it("rejects gatewayIds that cannot render as fleet Kubernetes resource names", async () => {
    const app = buildApp();
    for (const gatewayId of [
      "Bender",
      "gw_test",
      "-bender",
      "bender-",
      "a".repeat(33),
    ]) {
      const res = await request(app).post("/api/admin/gateways").send({
        gatewayId,
        imageRepository:
          "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
        imageTag: "abc1234",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/gatewayId/i);
    }
    expect(calls.some((c) => c.collection === "glmGateways")).toBe(false);
    expect(provisionerCalls).toEqual([]);
  });
});

describe("POST /api/admin/customers/:uid/migrate — body type guards", () => {
  it("rejects non-string `to` field with 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-bob/migrate")
      .send({ to: 42 });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/rollouts — body type guards", () => {
  it("rejects non-string imageTag with 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/rollouts")
      .send({ fromGatewayId: "default", imageTag: 9999 });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/admin/gateways/:id — retire", () => {
  it("sets desiredStatus=retired and creates a retire-gateway op when no customers are mounted", async () => {
    glmGatewaysDocs["canary"] = { gatewayId: "canary" };
    gatewaysDocs["canary"] = { gatewayId: "canary", status: "ready", mountedCustomers: [] };
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/canary");
    expect(res.status).toBe(202);
    const update = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.update",
    );
    expect(update?.data).toMatchObject({ desiredStatus: "retired" });
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data).toMatchObject({ kind: "retire-gateway", createdBy: "admin-user" });
  });

  it("defaults to full teardown — no retain flags on the retire-gateway op", async () => {
    glmGatewaysDocs["canary"] = { gatewayId: "canary" };
    gatewaysDocs["canary"] = { gatewayId: "canary", status: "ready", mountedCustomers: [] };
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/canary");
    expect(res.status).toBe(202);
    expect(res.body.retainData).toBe(false);
    expect(res.body.retainServiceAccount).toBe(false);
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data.input).toMatchObject({ gatewayId: "canary" });
    expect(op?.data.input.retainData).toBeUndefined();
    expect(op?.data.input.retainServiceAccount).toBeUndefined();
  });

  it("passes retainData + retainServiceAccount through to the retire-gateway operation", async () => {
    glmGatewaysDocs["canary"] = { gatewayId: "canary" };
    gatewaysDocs["canary"] = { gatewayId: "canary", status: "ready", mountedCustomers: [] };
    const app = buildApp();
    const res = await request(app)
      .delete("/api/admin/gateways/canary")
      .query({ retainData: "true", retainServiceAccount: "true" });
    expect(res.status).toBe(202);
    expect(res.body.retainData).toBe(true);
    expect(res.body.retainServiceAccount).toBe(true);
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data.input).toMatchObject({
      gatewayId: "canary",
      retainData: true,
      retainServiceAccount: true,
    });
  });

  it("returns 404 when the gateway does not exist", async () => {
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/gw-missing");
    expect(res.status).toBe(404);
  });

  it("returns 409 with the customer list when the gateway still has mounted customers", async () => {
    glmGatewaysDocs["canary"] = { gatewayId: "canary" };
    gatewaysDocs["canary"] = {
      gatewayId: "canary",
      status: "ready",
      mountedCustomers: ["alice", "bob"],
    };
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/canary");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still has mounted customers/i);
    expect(res.body.mountedCustomers).toEqual(["alice", "bob"]);
    const update = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.update",
    );
    expect(update).toBeUndefined();
  });

  it("proceeds with retire when the gateway has no heartbeat doc (stranded crash-loop case)", async () => {
    glmGatewaysDocs["orphan"] = { gatewayId: "orphan" };
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/orphan");
    expect(res.status).toBe(202);
    const update = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.update",
    );
    expect(update?.data).toMatchObject({ desiredStatus: "retired" });
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data).toMatchObject({ kind: "retire-gateway", createdBy: "admin-user" });
  });

  it("commits desiredStatus + op create as one atomic batch (P3 audit follow-up)", async () => {
    glmGatewaysDocs["canary"] = { gatewayId: "canary" };
    gatewaysDocs["canary"] = { gatewayId: "canary", status: "ready", mountedCustomers: [] };
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/canary");
    expect(res.status).toBe(202);

const updateIdx = calls.findIndex(
      (c) => c.collection === "glmGateways" && c.op === "doc.update",
    );
    const opIdx = calls.findIndex((c) => c.collection === "glmOperations");
    const commitIdx = calls.findIndex((c) => c.op === "batch.commit");
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(opIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(updateIdx);
    expect(commitIdx).toBeGreaterThan(opIdx);
  });

  it("rolls back BOTH writes if the batch commit fails (atomicity)", async () => {
    glmGatewaysDocs["canary"] = { gatewayId: "canary", desiredStatus: "running" };
    gatewaysDocs["canary"] = { gatewayId: "canary", status: "ready", mountedCustomers: [] };
    batchCommitFailures = 1;
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/canary");
    expect(res.status).toBe(500);
    
    expect(glmGatewaysDocs["canary"]).toMatchObject({ desiredStatus: "running" });
    expect(glmOperationsDocs.find((d) => d.data.kind === "retire-gateway")).toBeUndefined();
  });

});

describe("POST /api/admin/gateways/:id/rollout — bump gateway image", () => {
  const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

  it("creates a rollout op with the new imageTag (and inherited repo)", async () => {
    glmGatewaysDocs["default"] = {
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "oldSha",
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/default/rollout")
      .send({ imageTag: "abcdef1" });
    expect(res.status).toBe(202);
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data).toMatchObject({
      kind: "rollout",
      input: { gatewayId: "default", imageTag: "abcdef1" },
      createdBy: "admin-user",
    });
  });

  it("profile-only flip at the SAME sha is NOT a no-op — creates a rollout op carrying profile", async () => {
    glmGatewaysDocs["bender"] = {
      gatewayId: "bender",
      imageRepository: REPO,
      imageTag: "abcdef1",
      // no profile field → cattle/standard today
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/bender/rollout")
      .send({ imageTag: "abcdef1", profile: "operator" });
    expect(res.status).toBe(202);
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data).toMatchObject({
      kind: "rollout",
      input: { gatewayId: "bender", imageTag: "abcdef1", profile: "operator" },
    });
  });

  it("same sha AND same profile is still a 409 no-op (boundary not over-broadened)", async () => {
    glmGatewaysDocs["bender"] = {
      gatewayId: "bender",
      imageRepository: REPO,
      imageTag: "abcdef1",
      profile: "operator",
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/bender/rollout")
      .send({ imageTag: "abcdef1", profile: "operator" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no-op/);
    expect(calls.find((c) => c.collection === "glmOperations")).toBeUndefined();
  });

  it("rejects an unknown profile with 400 (no op written)", async () => {
    glmGatewaysDocs["default"] = {
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "oldSha",
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/default/rollout")
      .send({ imageTag: "abcdef1", profile: "root" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/profile/);
    expect(calls.find((c) => c.collection === "glmOperations")).toBeUndefined();
  });

  it("returns 400 when imageTag is not a SHA-style hex string (e.g. 'latest', 'v1.2.3')", async () => {
    glmGatewaysDocs["default"] = {
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "oldSha1",
    };
    const app = buildApp();
    for (const bad of ["latest", "v1.2.3", "ABC123def", "abc"]) {
      const res = await request(app)
        .post("/api/admin/gateways/default/rollout")
        .send({ imageTag: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/SHA/);
    }
    expect(calls.find((c) => c.collection === "glmOperations")).toBeUndefined();
  });

  it("returns 409 when another op is already pending or running for this gateway", async () => {
    glmGatewaysDocs["default"] = {
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "oldSha1",
    };
    glmOperationsDocs.push({
      id: "op-running-1",
      data: {
        kind: "migrate-customer",
        status: "running",
        input: { gatewayId: "default", uid: "u1" },
      },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/default/rollout")
      .send({ imageTag: "abcdef2" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already pending or running/);
    expect(res.body.operationId).toBe("op-running-1");
    expect(res.body.kind).toBe("migrate-customer");
  });

  it("returns 400 when imageTag is missing", async () => {
    glmGatewaysDocs["default"] = {
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "oldSha",
    };
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways/default/rollout").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/imageTag/);
  });

  it("returns 400 when imageRepository is not the canonical Octogee AR repo", async () => {
    glmGatewaysDocs["default"] = {
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "oldSha",
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/default/rollout")
      .send({ imageTag: "abcdef1", imageRepository: "evil.example.com/payload" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/imageRepository/);
  });

  it("returns 404 when the gateway is not registered", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/gw-missing/rollout")
      .send({ imageTag: "abcdef1" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the gateway is already on the requested image (no-op)", async () => {
    glmGatewaysDocs["default"] = {
      gatewayId: "default",
      imageRepository: REPO,
      imageTag: "1234567",
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/default/rollout")
      .send({ imageTag: "1234567" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no-op|already on/i);
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op).toBeUndefined();
  });

});

describe("POST /api/admin/gateways/:id/restart — rotate the pod via kubectl rollout restart", () => {
  const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

  it("creates a restart-gateway operation (kind carried in input)", async () => {
    glmGatewaysDocs["bender"] = {
      gatewayId: "bender",
      imageRepository: REPO,
      imageTag: "abcdef1",
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/bender/restart")
      .send({});
    expect(res.status).toBe(202);
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data).toMatchObject({
      kind: "restart-gateway",
      input: { gatewayId: "bender" },
      createdBy: "admin-user",
    });
  });

  it("returns 404 when the gateway is not registered", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/gw-missing/restart")
      .send({});
    expect(res.status).toBe(404);
    expect(calls.find((c) => c.collection === "glmOperations")).toBeUndefined();
  });

  it("does NOT gate on mountedCustomers — restart is operator intent", async () => {
    glmGatewaysDocs["bender"] = {
      gatewayId: "bender",
      imageRepository: REPO,
      imageTag: "abcdef1",
    };
    gatewaysDocs["bender"] = {
      gatewayId: "bender",
      status: "ready",
      mountedCustomers: ["alice", "bob"],
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/bender/restart")
      .send({});
    expect(res.status).toBe(202);
  });

  it("returns 409 when another op is already pending or running for this gateway", async () => {
    glmGatewaysDocs["bender"] = {
      gatewayId: "bender",
      imageRepository: REPO,
      imageTag: "abcdef1",
    };
    glmOperationsDocs.push({
      id: "op-running-99",
      data: {
        kind: "rollout",
        status: "running",
        input: { gatewayId: "bender", imageTag: "feedbee" },
      },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/bender/restart")
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already pending or running/);
    expect(res.body.operationId).toBe("op-running-99");
  });

});

describe("POST /api/admin/customers/:uid/migrate — start migration", () => {
  it("creates a migrate-customer operation", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/migrate")
      .send({ to: "canary" });
    expect(res.status).toBe(202);
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data).toMatchObject({
      kind: "migrate-customer",
      status: "pending",
      input: { uid: "uid-alice", toGatewayId: "canary" },
      createdBy: "admin-user",
    });
  });

  it("rejects without a target gateway", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/migrate")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when the target gateway is not registered", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/migrate")
      .send({ to: "gw-bogus" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the target gateway is registered but not ready", async () => {
    gatewaysDocs["gw-booting"] = { gatewayId: "gw-booting", status: "booting" };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/migrate")
      .send({ to: "gw-booting" });
    expect(res.status).toBe(409);
  });

  it("returns 409 when the target equals the customer's current gateway (migrate-to-self)", async () => {
    usersDocs["uid-alice"] = {
      provisioning: { openclaw: { slug: "alice", gatewayId: "canary" } },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/migrate")
      .send({ to: "canary" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
  });
});

describe("POST /api/admin/rollouts — composite operation", () => {
  it("creates a rollout operation with the source gateway + target image", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/rollouts").send({
      fromGatewayId: "default",
      imageTag: "def5678",
    });
    expect(res.status).toBe(202);
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data).toMatchObject({
      kind: "rollout",
      status: "pending",
      input: { fromGatewayId: "default", imageTag: "def5678" },
      createdBy: "admin-user",
    });
  });
});

describe("GET /api/admin/customers/by-slug/:slug — slug→uid lookup", () => {
  it("returns uid + currentGatewayId for a slug stored at provisioning.openclaw.slug", async () => {
    usersDocs["uid-alice"] = {
      provisioning: { openclaw: { slug: "alice", gatewayId: "canary" } },
    };
    const app = buildApp();
    const res = await request(app).get("/api/admin/customers/by-slug/alice");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uid: "uid-alice", currentGatewayId: "canary" });
  });

  it("falls back to username when no provisioning slug matches", async () => {
    usersDocs["uid-bob"] = { username: "bob" };
    const app = buildApp();
    const res = await request(app).get("/api/admin/customers/by-slug/bob");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uid: "uid-bob", currentGatewayId: null });
  });

  it("returns currentGatewayId=null when the user doc has no provisioned gateway yet", async () => {
    usersDocs["uid-claire"] = {
      provisioning: { openclaw: { slug: "claire" } },
    };
    const app = buildApp();
    const res = await request(app).get("/api/admin/customers/by-slug/claire");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uid: "uid-claire", currentGatewayId: null });
  });

  it("returns 404 when no user has the slug or username", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/admin/customers/by-slug/ghost");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/admin/customer-distribution — fleet-wide ops view", () => {
  it("buckets approved users into mounted / assigned-not-mounted / unassigned", async () => {
    gatewaysDocs = {
      "default": { status: "ready", mountedCustomers: ["alice", "bob"] },
    };
    usersDocs = {
      "uid-alice": {
        approved: true,
        username: "alice",
        email: "alice@example.com",
        provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
      },
      "uid-bob": {
        approved: true,
        username: "bob",
        email: "bob@example.com",
        provisioning: { openclaw: { slug: "bob", gatewayId: "default" } },
      },
      "uid-carol": {
        approved: true,
        username: "carol",
        email: "carol@example.com",
        provisioning: { openclaw: { slug: "carol", gatewayId: "default" } },
      },
      "uid-dave": {
        approved: true,
        username: "dave",
        email: "dave@example.com",
        provisioning: {},
      },
      "uid-eve": {
        approved: false,
        username: "eve",
        email: "eve@example.com",
        provisioning: { openclaw: { slug: "eve", gatewayId: "default" } },
      },
    };
    const app = buildApp();
    const res = await request(app).get("/api/admin/customer-distribution");
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({
      totalApproved: 4,
      assigned: 3,
      unassigned: 1,
      mounted: 2,
      assignedNotMounted: 1,
    });
    expect(res.body.pendingPlacements).toHaveLength(1);
    expect(res.body.pendingPlacements[0]).toMatchObject({
      uid: "uid-dave",
      username: "dave",
      reason: "never-assigned",
      currentGatewayId: null,
    });
    expect(res.body.perGateway).toEqual([
      expect.objectContaining({
        gatewayId: "default",
        status: "ready",
        assignedCount: 3,
        mountedCount: 2,
      }),
    ]);
  });

  it("flags users whose gateway no longer exists with reason='gateway-gone'", async () => {
    gatewaysDocs = {
      "default": { status: "ready", mountedCustomers: [] },
    };
    usersDocs = {
      "uid-orphan": {
        approved: true,
        username: "orphan",
        email: "orphan@example.com",
        provisioning: { openclaw: { slug: "orphan", gatewayId: "gw-deleted" } },
      },
    };
    const app = buildApp();
    const res = await request(app).get("/api/admin/customer-distribution");
    expect(res.status).toBe(200);
    expect(res.body.pendingPlacements).toHaveLength(1);
    expect(res.body.pendingPlacements[0]).toMatchObject({
      uid: "uid-orphan",
      reason: "gateway-gone",
      currentGatewayId: "gw-deleted",
    });
  });

  it("returns empty buckets when no approved users exist", async () => {
    gatewaysDocs = {
      "default": { status: "ready", mountedCustomers: [] },
    };
    usersDocs = {};
    const app = buildApp();
    const res = await request(app).get("/api/admin/customer-distribution");
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({
      totalApproved: 0,
      assigned: 0,
      unassigned: 0,
      mounted: 0,
    });
    expect(res.body.pendingPlacements).toEqual([]);
  });
});

describe("POST /api/admin/customers/:uid/assign — initial placement", () => {
  it("writes provisioning.openclaw.gatewayId on the user doc", async () => {
    gatewaysDocs = {
      "default": { status: "ready", mountedCustomers: [] },
    };
    usersDocs = {
      "uid-dave": { approved: true, username: "dave", email: "dave@example.com" },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-dave/assign")
      .send({ gatewayId: "default" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ uid: "uid-dave", gatewayId: "default" });
    const update = calls.find(
      (c) => c.collection === "users" && c.op === "doc.update",
    );
    expect(update?.data).toMatchObject({
      "provisioning.openclaw.gatewayId": "default",
    });
  });

  it("does not grant shell access when assigning to an operator-profile gateway", async () => {
    gatewaysDocs = {
      "gw-operator": { status: "ready", mountedCustomers: [] },
    };
    glmGatewaysDocs = {
      "gw-operator": { gatewayId: "gw-operator", profile: "operator" },
    };
    usersDocs = {
      "uid-dave": { approved: true, username: "dave", email: "dave@example.com" },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-dave/assign")
      .send({ gatewayId: "gw-operator" });
    expect(res.status).toBe(202);

    const grant = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.update" && c.docId === "gw-operator",
    );
    expect(grant).toBeUndefined();
    const userUpdate = calls.find(
      (c) => c.collection === "users" && c.op === "doc.update" && c.docId === "uid-dave",
    );
    expect(userUpdate?.data).toMatchObject({
      "provisioning.openclaw.gatewayId": "gw-operator",
      "provisioning.openclaw.gatewayProfile": "operator",
      "provisioning.openclaw.shellsEnabled": false,
    });
  });

  it("returns 400 when gatewayId is missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-dave/assign")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when the user does not exist", async () => {
    gatewaysDocs = { "default": { status: "ready" } };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-missing/assign")
      .send({ gatewayId: "default" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/user not found/);
  });

  it("returns 409 when the user is not approved", async () => {
    gatewaysDocs = { "default": { status: "ready" } };
    usersDocs = {
      "uid-pending": { approved: false, username: "pending", email: "pending@example.com" },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-pending/assign")
      .send({ gatewayId: "default" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not approved/);
  });

  it("returns 404 when the target gateway is not registered", async () => {
    usersDocs = { "uid-dave": { approved: true } };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-dave/assign")
      .send({ gatewayId: "gw-missing" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/gateway not found/);
  });

  it("returns 409 when the target gateway is not ready (booting/unreachable/draining)", async () => {
    gatewaysDocs = { "default": { status: "booting" } };
    usersDocs = { "uid-dave": { approved: true } };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-dave/assign")
      .send({ gatewayId: "default" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not ready/);
  });

  it("returns 409 when the user is already assigned to that gateway (no-op)", async () => {
    gatewaysDocs = { "default": { status: "ready" } };
    usersDocs = {
      "uid-alice": {
        approved: true,
        provisioning: { openclaw: { gatewayId: "default" } },
      },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/assign")
      .send({ gatewayId: "default" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already assigned/);
  });
});

describe("GET /api/admin/gateways/:id/details — drawer payload", () => {
  it("returns mounted-customer details + recent ops for the gateway", async () => {
    glmGatewaysDocs = {
      "default": { gatewayId: "default", imageTag: "abc1234" },
    };
    gatewaysDocs = {
      "default": {
        gatewayId: "default",
        status: "ready",
        mountedCustomers: ["alice", "bob"],
      },
    };
    usersDocs = {
      "uid-alice": {
        approved: true,
        username: "alice",
        email: "alice@octogee.com",
        throttleLevel: 0,
        lastActive: "2026-05-04T09:00:00Z",
        provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
      },
      "uid-bob": {
        approved: true,
        username: "bob",
        email: "bob@octogee.com",
        throttleLevel: 2,
        lastActive: "2026-05-04T08:30:00Z",
        provisioning: { openclaw: { slug: "bob", gatewayId: "default" } },
      },
      "uid-carol": {
        approved: true,
        username: "carol",
        email: "carol@octogee.com",
        provisioning: { openclaw: { slug: "carol", gatewayId: "gw-other" } },
      },
    };
    glmOperationsDocs = [
      {
        id: "op-this-gw",
        data: {
          kind: "rollout",
          status: "succeeded",
          createdAt: 5_000,
          gatewayId: "default",
          input: { gatewayId: "default", imageTag: "abc1234" },
          steps: [],
        },
      },
      {
        id: "op-other-gw",
        data: {
          kind: "rollout",
          status: "succeeded",
          createdAt: 4_000,
          gatewayId: "gw-other",
          input: { gatewayId: "gw-other" },
          steps: [],
        },
      },
    ];
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways/default/details");
    expect(res.status).toBe(200);
    expect(res.body.mountedCustomers).toHaveLength(2);
    const slugs = res.body.mountedCustomers.map((m: { slug: string }) => m.slug).sort();
    expect(slugs).toEqual(["alice", "bob"]);
    const alice = res.body.mountedCustomers.find(
      (m: { slug: string }) => m.slug === "alice",
    );
    expect(alice).toMatchObject({
      uid: "uid-alice",
      username: "alice",
      email: "alice@octogee.com",
      throttleLevel: 0,
    });
    expect(res.body.recentOperations).toHaveLength(1);
    expect(res.body.recentOperations[0].id).toBe("op-this-gw");
    expect(res.body.generatedAt).toBeTruthy();
  });

  it("returns empty mountedCustomers when the gateway heartbeat doc has no mounts", async () => {
    glmGatewaysDocs = { "gw-empty": { gatewayId: "gw-empty" } };
    gatewaysDocs = {
      "gw-empty": { gatewayId: "gw-empty", status: "ready", mountedCustomers: [] },
    };
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways/gw-empty/details");
    expect(res.status).toBe(200);
    expect(res.body.mountedCustomers).toEqual([]);
  });

  it("404s for an unknown gateway", async () => {
    glmGatewaysDocs = {};
    gatewaysDocs = {};
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways/gw-missing/details");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("survives a missing heartbeat doc when the desired-state record exists", async () => {
    glmGatewaysDocs = { "gw-booting": { gatewayId: "gw-booting" } };
    gatewaysDocs = {};
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways/gw-booting/details");
    expect(res.status).toBe(200);
    expect(res.body.mountedCustomers).toEqual([]);
  });

  it("only returns operations whose input.gatewayId matches the path id", async () => {
    glmGatewaysDocs = { "default": { gatewayId: "default" } };
    gatewaysDocs = {
      "default": { gatewayId: "default", status: "ready", mountedCustomers: [] },
    };
    glmOperationsDocs = [
      {
        id: "op-a",
        data: {
          kind: "rollout",
          status: "succeeded",
          createdAt: 5_000,
          gatewayId: "default",
          input: { gatewayId: "default" },
          steps: [],
        },
      },
      {
        id: "op-b",
        data: {
          kind: "migrate-customer",
          status: "succeeded",
          createdAt: 4_000,
          input: { uid: "uid-alice" },
          steps: [],
        },
      },
      {
        id: "op-c",
        data: {
          kind: "add-gateway",
          status: "succeeded",
          createdAt: 3_000,
          gatewayId: "gw-other",
          input: { gatewayId: "gw-other" },
          steps: [],
        },
      },
    ];
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways/default/details");
    expect(res.status).toBe(200);
    expect(res.body.recentOperations.map((o: { id: string }) => o.id)).toEqual(["op-a"]);
  });
});

describe("GET /api/admin/builds — Artifact Registry SHA picker", () => {
  it("returns the recent SHA-tagged builds for the requested service", async () => {
    nextBuildsResult = [
      { tag: "abc1234", pushedAt: "2026-05-04T10:00:00Z", digest: "sha256:aaa" },
      { tag: "def5678", pushedAt: "2026-05-03T08:00:00Z", digest: "sha256:bbb" },
    ];
    const app = buildApp();
    const res = await request(app).get("/api/admin/builds?service=octogee-gateway");
    expect(res.status).toBe(200);
    expect(res.body.builds).toHaveLength(2);
    expect(res.body.builds[0].tag).toBe("abc1234");
    expect(res.body.service).toBe("octogee-gateway");
    expect(res.body.generatedAt).toBeTruthy();
    expect(builderCalls[0].service).toBe("octogee-gateway");
  });

  it("defaults to octogee-gateway when no service is provided", async () => {
    nextBuildsResult = [];
    const app = buildApp();
    const res = await request(app).get("/api/admin/builds");
    expect(res.status).toBe(200);
    expect(res.body.service).toBe("octogee-gateway");
    expect(builderCalls[0].service).toBe("octogee-gateway");
  });

  it("rejects services outside the allowlist", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/admin/builds?service=evil-image");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service/i);
    expect(builderCalls).toHaveLength(0);
  });

  it("accepts the gateway-edge service; rejects the retired chat-proxy image", async () => {
    nextBuildsResult = [];
    const app = buildApp();

const a = await request(app).get("/api/admin/builds?service=octogee-chat-proxy");
    const b = await request(app).get("/api/admin/builds?service=gateway-edge");
    expect(a.status).toBe(400);
    expect(b.status).toBe(200);
    expect(builderCalls.map((c) => c.service)).toEqual(["gateway-edge"]);
  });

  it("clamps limit to a sane maximum", async () => {
    nextBuildsResult = [];
    const app = buildApp();
    const res = await request(app).get("/api/admin/builds?limit=500");
    expect(res.status).toBe(200);
    expect(builderCalls[0].limit).toBeLessThanOrEqual(100);
  });

  it("propagates Artifact Registry failures as 502", async () => {
    nextBuildsError = new Error("artifact-registry list failed: 403 Forbidden");
    const app = buildApp();
    const res = await request(app).get("/api/admin/builds");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/artifact-registry/i);
  });
});

describe("GET /api/admin/operations — history", () => {
  it("returns a list of operations with newest first", async () => {
    glmOperationsDocs = [
      {
        id: "op-newer",
        data: {
          kind: "migrate-customer",
          status: "succeeded",
          createdAt: 2_000,
          steps: [],
        },
      },
      {
        id: "op-older",
        data: {
          kind: "add-gateway",
          status: "succeeded",
          createdAt: 1_000,
          steps: [],
        },
      },
    ];
    const app = buildApp();
    const res = await request(app).get("/api/admin/operations");
    expect(res.status).toBe(200);
    expect(res.body.operations).toHaveLength(2);
    expect(res.body.operations[0].id).toBe("op-newer");
  });
});
