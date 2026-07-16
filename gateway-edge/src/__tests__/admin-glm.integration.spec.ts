import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FieldValue } from "firebase-admin/firestore";

interface FirestoreCall {
  collection: string;
  op: "add" | "doc.set" | "doc.update" | "batch.commit" | "transaction.commit";
  docId?: string;
  data?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

let transactionCommitFailures = 0;

const calls: FirestoreCall[] = [];
let glmOperationsDocs: Array<{ id: string; data: Record<string, unknown> }> = [];
let glmGatewaysDocs: Record<string, Record<string, unknown>> = {};
let gatewaysDocs: Record<string, Record<string, unknown>> = {};
// Step 2 release docs live at gateways/{id}/releases/{n}; keyed here by
// `${gatewayId}/${release}` so the fake can serve subcollection reads/writes.
let gatewayReleasesDocs: Record<string, Record<string, unknown>> = {};
// PR7 durable roster docs at gateways/{id}/assignments/{uid}; keyed by
// `${gatewayId}/${uid}` so the fake can serve subcollection + collectionGroup.
let gatewayAssignmentsDocs: Record<string, Record<string, unknown>> = {};
let usersDocs: Record<string, Record<string, unknown>> = {};
let configDocs: Record<string, Record<string, unknown>> = {};
let operatorGatewayReservationsDocs: Record<string, Record<string, unknown>> = {};

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
        if (name === "config") {
          const data = configDocs[docId];
          return { exists: data !== undefined, data: () => data };
        }
        return { exists: true, data: () => ({}) };
      },
      set: async (data: Record<string, unknown>, options?: Record<string, unknown>) => {
        calls.push({ collection: name, op: "doc.set", docId, data, options });
        if (name === "glmGateways") glmGatewaysDocs[docId] = data;
        if (name === "glmOperations") glmOperationsDocs.unshift({ id: docId, data });
        if (name === "users") usersDocs[docId] = data;
        if (name === "config") configDocs[docId] = options?.merge ? { ...(configDocs[docId] ?? {}), ...data } : data;
        if (name === "operatorGatewayReservations") operatorGatewayReservationsDocs[docId] = data;
        if (name === "gateways") {
          gatewaysDocs[docId] = options?.merge
            ? { ...(gatewaysDocs[docId] ?? {}), ...data }
            : data;
        }
      },
      update: async (data: Record<string, unknown>) => {
        calls.push({ collection: name, op: "doc.update", docId, data });
        if (name === "glmGateways" && glmGatewaysDocs[docId]) {
          glmGatewaysDocs[docId] = { ...glmGatewaysDocs[docId], ...data };
        }
        if (name === "users" && usersDocs[docId]) {
          usersDocs[docId] = { ...usersDocs[docId], ...data };
        }
        if (name === "config" && configDocs[docId]) {
          configDocs[docId] = { ...configDocs[docId], ...data };
        }
        if (name === "operatorGatewayReservations" && operatorGatewayReservationsDocs[docId]) {
          operatorGatewayReservationsDocs[docId] = { ...operatorGatewayReservationsDocs[docId], ...data };
        }
        if (name === "gateways" && gatewaysDocs[docId]) {
          gatewaysDocs[docId] = { ...gatewaysDocs[docId], ...data };
        }
      },
      // Step 2 subcollections: gateways/{id}/releases/{n} (release records) and
      // gateways/{id}/assignments/{uid} (PR7 durable roster docs).
      collection: (subName: string) => {
        const key = (rid: string) => `${docId}/${rid}`;
        if (subName === "assignments") {
          return {
            doc: (uid: string) => ({
              id: uid,
              __isDoc: true,
              get: async () => {
                const d = gatewayAssignmentsDocs[key(uid)];
                return { id: uid, exists: d !== undefined, data: () => d };
              },
              set: async (data: Record<string, unknown>) => {
                calls.push({ collection: `${name}/${docId}/assignments`, op: "doc.set", docId: uid, data });
                gatewayAssignmentsDocs[key(uid)] = data;
              },
              update: async (data: Record<string, unknown>) => {
                calls.push({ collection: `${name}/${docId}/assignments`, op: "doc.update", docId: uid, data });
                if (gatewayAssignmentsDocs[key(uid)]) {
                  gatewayAssignmentsDocs[key(uid)] = { ...gatewayAssignmentsDocs[key(uid)], ...data };
                }
              },
              delete: async () => {
                calls.push({ collection: `${name}/${docId}/assignments`, op: "doc.delete", docId: uid });
                delete gatewayAssignmentsDocs[key(uid)];
              },
            }),
            // Retire enumerates the gateway's assignments to refuse while
            // customers are still assigned.
            get: async () => {
              const prefix = `${docId}/`;
              const docs = Object.entries(gatewayAssignmentsDocs)
                .filter(([k]) => k.startsWith(prefix))
                .map(([k, d]) => ({ id: k.slice(prefix.length), exists: true, data: () => d }));
              return { empty: docs.length === 0, size: docs.length, docs };
            },
          };
        }
        return {
          doc: (rid: string) => ({
            id: rid,
            get: async () => {
              const d = gatewayReleasesDocs[key(rid)];
              return { id: rid, exists: d !== undefined, data: () => d };
            },
            set: async (data: Record<string, unknown>) => {
              calls.push({ collection: `${name}/${docId}/${subName}`, op: "doc.set", docId: rid, data });
              gatewayReleasesDocs[key(rid)] = data;
            },
          }),
          orderBy: (field: string, dir = "asc") => ({
            get: async () => {
              const docs = Object.entries(gatewayReleasesDocs)
                .filter(([k]) => k.startsWith(`${docId}/`))
                .map(([k, data]) => ({ id: k.split("/")[1], data: () => data }));
              docs.sort((a, b) => {
                const av = (a.data() as Record<string, number>)[field];
                const bv = (b.data() as Record<string, number>)[field];
                const cmp = av < bv ? -1 : av > bv ? 1 : 0;
                return dir === "desc" ? -cmp : cmp;
              });
              return { docs, size: docs.length };
            },
          }),
        };
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
        for (const fn of pending) await fn();
        calls.push({ collection: "<batch>", op: "batch.commit" });
      },
    };
  }

  return {
    db: {
      collection,
      collectionGroup: (name: string) => ({
        get: async () => {
          if (name === "assignments") {
            const docs = Object.entries(gatewayAssignmentsDocs).map(([k, data]) => ({
              id: k.split("/")[1],
              data: () => data,
            }));
            return { docs, size: docs.length };
          }
          return { docs: [], size: 0 };
        },
      }),
      // Buffered transaction over the existing ref methods (Firestore
      // all-or-nothing): writes apply only after the body resolves.
      runTransaction: async (body: (txn: any) => Promise<unknown>) => {
        const pending: Array<() => Promise<void>> = [];
        const txn = {
          get: (refOrQuery: any) => refOrQuery.get(),
          update: (ref: any, data: Record<string, unknown>) => {
            pending.push(() => ref.update(data));
          },
          set: (ref: any, data: Record<string, unknown>, options?: Record<string, unknown>) => {
            pending.push(() => ref.set(data, options));
          },
          delete: (ref: any) => {
            pending.push(() => ref.delete());
          },
        };
        const result = await body(txn);
        if (transactionCommitFailures > 0) {
          transactionCommitFailures -= 1;
          throw new Error("simulated transaction commit failure");
        }
        for (const fn of pending) await fn();
        calls.push({ collection: "<transaction>", op: "transaction.commit" });
        return result;
      },
      batch: () => makeBatch(),
      doc: (path: string) => {
        const [coll, id] = path.split("/");
        return makeDocRef(coll, id);
      },
      getAll: async () => [],
    },
    FieldValue: { serverTimestamp: () => "now", delete: () => ({ __delete: true }) },
    Timestamp: { now: () => ({ toDate: () => new Date() }) },
  };
});

const provisionerCalls: Array<{ gatewayId: string; gatewayServiceAccount: string }> = [];
let provisionerNextError: Error | null = null;

vi.mock("@octogee/core/secret-manager", () => ({
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

vi.mock("@octogee/core/artifact-registry", () => ({
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

const GATEWAY_REPOSITORY =
  "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

function seedDurableGateway(
  gatewayId: string,
  options: {
    imageTag?: string;
    heartbeat?: Record<string, unknown>;
    root?: Record<string, unknown>;
  } = {},
) {
  const imageTag = options.imageTag ?? "abc1234";
  gatewaysDocs[gatewayId] = {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: null,
    liveRevisionId: null,
    trafficRevisionId: null,
    desiredStatus: "running",
    roll: null,
    configSchemaVersion: 1,
    profile: "standard",
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    operatorAccess: null,
    ownerUid: null,
    coOwnerUids: [],
    builderSlug: null,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
    ...options.root,
  };
  gatewayReleasesDocs[`${gatewayId}/1`] = {
    gatewayId,
    release: 1,
    createdAt: 1,
    createdBy: "test",
    sourceRelease: null,
    note: null,
    payloadHash: "0".repeat(64),
    payload: {
      imageRepository: GATEWAY_REPOSITORY,
      imageTag,
    },
  };
  if (options.heartbeat) markGatewayServing(gatewayId, options.heartbeat);
}

function markGatewayServing(
  gatewayId: string,
  heartbeat: Record<string, unknown>,
) {
  const revisionId = `${gatewayId}-r1`;
  gatewaysDocs[gatewayId] = {
    ...gatewaysDocs[gatewayId],
    liveRelease: 1,
    liveRevisionId: revisionId,
    trafficRevisionId: revisionId,
  };
  glmGatewaysDocs[revisionId] = {
    docKind: "revision",
    revisionId,
    gateway: gatewayId,
    release: 1,
    rollRole: "serving",
    lifecycle: "serving",
    createdAt: 1,
    createdByOperationId: null,
    retiredAt: null,
    retireReason: null,
    helm: {},
    heartbeat,
    lastError: { message: null, at: null },
  };
}

function seedRetirableGateway(gatewayId: string) {
  const observedAt = Date.now();
  seedDurableGateway(gatewayId, {
    heartbeat: {
      status: "ready",
      lastHeartbeatAt: observedAt,
      startedAt: observedAt - 1_000,
      version: "abc1234",
      openclawVersion: "2026.7.1",
      mountedCustomers: [],
    },
  });
}

beforeEach(() => {
  calls.length = 0;
  glmOperationsDocs = [];
  glmGatewaysDocs = {};
  gatewaysDocs = {};
  gatewayReleasesDocs = {};
  gatewayAssignmentsDocs = {};
  usersDocs = {};
  configDocs = {};
  operatorGatewayReservationsDocs = {};
  provisionerCalls.length = 0;
  provisionerNextError = null;
  builderCalls.length = 0;
  nextBuildsResult = [];
  nextBuildsError = null;
  transactionCommitFailures = 0;
  process.env.GATEWAY_SERVICE_ACCOUNT = "octogee-gateway@octogee-test.iam.gserviceaccount.com";
});

describe("Admin onboarding placement", () => {
  it("projects policy target, assigned gateway, mounted gateway, and pointer drift separately", async () => {
    configDocs.orchestrator = {
      defaultGatewayId: "gw-target",
      overrides: {},
    };
    seedDurableGateway("gw-source", {
      imageTag: "oldsha1",
      heartbeat: { status: "ready", mountedCustomers: ["alice"] },
    });
    seedDurableGateway("gw-target", {
      imageTag: "newsha1",
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs = {
      "uid-alice": {
        username: "alice",
        provisioning: {
          openclaw: {
            slug: "alice",
            gatewayId: "gw-source",
          },
        },
      },
    };

    const res = await request(buildApp()).get("/api/admin/onboarding-placement");

    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({ defaultGatewayId: "gw-target", overrides: {} });
    expect(res.body.driftSummary["pointer-drift"]).toBe(1);
    expect(res.body.customers).toEqual([
      expect.objectContaining({
        uid: "uid-alice",
        slug: "alice",
        policyTargetGatewayId: "gw-target",
        assignedGatewayId: "gw-source",
        mountedGatewayId: "gw-source",
        driftState: "pointer-drift",
      }),
    ]);
    expect(res.body.gateways).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gatewayId: "gw-target",
          defaultTarget: true,
          assignedCount: 0,
          mountedCount: 0,
          driftCount: 1,
        }),
        expect.objectContaining({
          gatewayId: "gw-source",
          defaultTarget: false,
          assignedCount: 1,
          mountedCount: 1,
          driftCount: 1,
        }),
      ]),
    );
  });

  it("persists a validated default gateway and per-uid overrides", async () => {
    configDocs.orchestrator = { defaultGatewayId: "gw-old", overrides: {} };
    seedDurableGateway("gw-new");
    usersDocs = {
      "uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice", gatewayId: "gw-new" } },
      },
    };

    const patched = await request(buildApp())
      .patch("/api/admin/onboarding-placement")
      .send({ defaultGatewayId: "gw-new" });
    expect(patched.status).toBe(200);
    expect(configDocs.orchestrator).toMatchObject({ defaultGatewayId: "gw-new" });

    const pinned = await request(buildApp())
      .put("/api/admin/onboarding-placement/overrides/uid-alice")
      .send({ gatewayId: "gw-new" });
    expect(pinned.status).toBe(200);
    expect(configDocs.orchestrator).toMatchObject({ overrides: { "uid-alice": "gw-new" } });

    const cleared = await request(buildApp()).delete(
      "/api/admin/onboarding-placement/overrides/uid-alice",
    );
    expect(cleared.status).toBe(200);
    expect((configDocs.orchestrator as { overrides?: Record<string, string> }).overrides).toEqual({});
  });

  it("rejects a default gateway pointed at a dedicated (non-shared) gateway", async () => {
    configDocs.orchestrator = { defaultGatewayId: "gw-old", overrides: {} };
    seedDurableGateway("gw-builder", {
      root: {
        gatewayClass: "builder",
        ownerUid: "uid-builder",
        builderSlug: "builder",
      },
    });

    const res = await request(buildApp())
      .patch("/api/admin/onboarding-placement")
      .send({ defaultGatewayId: "gw-builder" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("shared gateway");
  });
});

describe("POST /api/admin/gateways — create durable state + op", () => {
  it("writes a durable gateway root and immutable release with an add-gateway operation", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "created-canary",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ gatewayId: "created-canary" });
    expect(res.body.operationId).toBeTruthy();

    const gwWrite = calls.find(
      (c) => c.collection === "gateways" && c.op === "doc.set",
    );
    expect(gwWrite?.docId).toBe("created-canary");
    expect(gwWrite?.data).toMatchObject({
      gatewayId: "created-canary",
      desiredStatus: "running",
      createdBy: "admin-user",
      latestRelease: 1,
      desiredRelease: 1,
    });
    expect(glmGatewaysDocs["created-canary"]).toBeUndefined();

    const opWrite = calls.find((c) => c.collection === "glmOperations");
    expect(opWrite?.data).toMatchObject({
      kind: "add-gateway",
      status: "pending",
      createdBy: "admin-user",
      gatewayId: "created-canary",
    });

    expect(gatewaysDocs["created-canary"]).toMatchObject({
      gatewayId: "created-canary",
      latestRelease: 1,
      desiredRelease: 1,
      desiredStatus: "running",
    });
    const releaseWrite = calls.find(
      (c) => c.collection === "gateways/created-canary/releases" && c.op === "doc.set",
    );
    expect(releaseWrite?.docId).toBe("1");
    expect(releaseWrite?.data).toMatchObject({
      release: 1,
      sourceRelease: null,
      payload: { imageTag: "abc1234" },
    });
  });

  it("rejects bodies missing required fields with 400", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({ gatewayId: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects new gateway ids ending in the reserved -blue/-green roll-role suffixes", async () => {
    const app = buildApp();
    for (const gatewayId of ["team-blue", "team-green"]) {
      const res = await request(app).post("/api/admin/gateways").send({
        gatewayId,
        imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
        imageTag: "abc1234",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reserved for roll roles/);
      expect(
        calls.find((c) => c.collection === "glmGateways" && c.docId === gatewayId),
      ).toBeUndefined();
    }
  });

  it("persists sizingTier and profile when supplied in the body", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "created-operator",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
      profile: "operator",
      sizingTier: "large",
    });
    expect(res.status).toBe(202);
    const gwWrite = calls.find(
      (c) => c.collection === "gateways" && c.op === "doc.set",
    );
    expect(gwWrite?.data).toMatchObject({
      profile: "operator",
      gatewayClass: "operator",
      imageProfile: "operator",
      sizingTier: "large",
      operatorAccess: {
        shellsEnabled: false,
        reason: "runtime-trust-boundary-not-provisioned",
      },
      serviceAccountName: "octogee-gw-created-operator",
      serviceAccount: {
        create: true,
      },
    });
  });

  it("reserves an operator gateway for a real owner and enables BuilderShell", async () => {
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
      (c) => c.collection === "gateways" && c.op === "doc.set",
    );
    expect(gwWrite?.data).toMatchObject({
      gatewayId: "jack",
      profile: "operator",
      ownerUid: "uid-jack",
      builderSlug: "jack",
      operatorAccess: {
        shellsEnabled: true,
        reason: "owned-runtime-gateway",
      },
    });
    expect(gwWrite?.data).not.toHaveProperty("operatorReservation");

    const opWrite = calls.find((c) => c.collection === "glmOperations");
    expect(opWrite?.data?.input).toMatchObject({
      gatewayId: "jack",
      profile: "operator",
      ownerUid: "uid-jack",
      builderSlug: "jack",
    });
  });

  it("creates a builder-class standard gateway for a real owner with runtime access state", async () => {
    usersDocs["uid-jack"] = {
      username: "jack",
      provisioning: { openclaw: { slug: "jack" } },
    };
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "jack",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
      gatewayClass: "builder",
      ownerUid: "uid-jack",
    });
    expect(res.status).toBe(202);

    const gwWrite = calls.find(
      (c) => c.collection === "gateways" && c.op === "doc.set",
    );
    expect(gwWrite?.data).toMatchObject({
      gatewayId: "jack",
      gatewayClass: "builder",
      ownerUid: "uid-jack",
      builderSlug: "jack",
      operatorAccess: {
        shellsEnabled: true,
        reason: "owned-runtime-gateway",
      },
    });
    expect(gwWrite?.data).toMatchObject({
      imageProfile: "standard",
      serviceAccountName: null,
    });
    expect(gwWrite?.data).not.toHaveProperty("operatorReservation");

    const opWrite = calls.find((c) => c.collection === "glmOperations");
    expect(opWrite?.data?.input).toMatchObject({
      gatewayId: "jack",
      gatewayClass: "builder",
      ownerUid: "uid-jack",
      builderSlug: "jack",
    });
  });

  it("rejects builder-class gateways without an owner before side effects", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "jack",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
      gatewayClass: "builder",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ownerUid/);
    expect(provisionerCalls).toEqual([]);
    const gwWrite = calls.find(
      (c) => c.collection === "gateways" && c.op === "doc.set",
    );
    expect(gwWrite).toBeUndefined();
  });

  it("rejects owner fields on shared gateways before side effects", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "shared-with-owner",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
      ownerUid: "uid-jack",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gatewayClass=builder or gatewayClass=operator/);
    expect(provisionerCalls).toEqual([]);
    const gwWrite = calls.find(
      (c) => c.collection === "gateways" && c.op === "doc.set",
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
      (c) => c.collection === "gateways" && c.op === "doc.set",
    );
    expect(gwWrite).toBeUndefined();
  });

  it("rejects unknown sizingTier values on create with 400", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "invalid-tier",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
      sizingTier: "bogus-tier",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sizingTier/);
    const gwWrite = calls.find(
      (c) => c.collection === "gateways" && c.op === "doc.set",
    );
    expect(gwWrite).toBeUndefined();
  });

  it("provisions the gateway-auth-token Secret Manager shell before writing the durable root", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "secret-ready",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
    });
    expect(res.status).toBe(202);
    expect(provisionerCalls).toEqual([
      {
        gatewayId: "secret-ready",
        gatewayServiceAccount: "octogee-gateway@octogee-test.iam.gserviceaccount.com",
      },
    ]);
  });

  it("does NOT write the durable root if SM provisioning fails — operator gets 502 with detail", async () => {
    provisionerNextError = new Error("PERMISSION_DENIED on secretmanager.secrets.create");
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "secret-failure",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/auth-token/);
    const gwWrite = calls.find((c) => c.collection === "gateways" && c.op === "doc.set");
    expect(gwWrite).toBeUndefined();
  });

  it("returns 500 if GATEWAY_SERVICE_ACCOUNT is not configured (cluster misconfigured)", async () => {
    delete process.env.GATEWAY_SERVICE_ACCOUNT;
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "missing-service-account",
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
    seedDurableGateway("gw-existing");
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "gw-existing",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
    });
    expect(res.status).toBe(409);
  });

});

describe("PATCH /api/admin/gateways/:id — durable config only", () => {
  it("rejects an imageTag write when the gateway has mounted customers", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: ["u1", "u2"] },
    });
    const app = buildApp();

    const res = await request(app).patch("/api/admin/gateways/default").send({ imageTag: "new" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/immutable releases/i);
    expect(gatewaysDocs["default"].latestRelease).toBe(1);
  });

  it("rejects an imageTag write on an empty gateway", async () => {
    seedDurableGateway("canary");
    const app = buildApp();

    const res = await request(app).patch("/api/admin/gateways/canary").send({ imageTag: "new" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/immutable releases/i);
    expect(gatewayReleasesDocs["canary/1"].payload).toMatchObject({ imageTag: "abc1234" });
  });

  it("allows a non-image PATCH (desiredStatus) on a mounted gateway", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: ["u1"] },
    });
    const app = buildApp();

    const res = await request(app).patch("/api/admin/gateways/default").send({ desiredStatus: "paused" });

    expect(res.status).toBe(202);
    expect(gatewaysDocs["default"].desiredStatus).toBe("paused");
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
      (c) => c.collection === "gateways" && c.op === "doc.set",
    );
    expect(gwWrite?.data).toMatchObject({
      gatewayId: "alice",
      profile: "operator",
      gatewayClass: "operator",
      imageProfile: "operator",
      ownerUid: "admin-user",
      builderSlug: "alice",
      sizingTier: "large",
      operatorAccess: {
        shellsEnabled: true,
        reason: "owned-runtime-gateway",
      },
      serviceAccountName: "octogee-gw-alice",
      serviceAccount: { create: true },
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

    markGatewayServing("alice", { status: "ready", mountedCustomers: [] });
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
      (c) => c.collection === "gateways" && c.op === "doc.set",
    );
    expect(gwWrite?.docId).toBe("alice");
    expect(gwWrite?.data).toMatchObject({
      gatewayId: "alice",
      desiredStatus: "running",
      profile: "operator",
      gatewayClass: "operator",
      imageProfile: "operator",
      ownerUid: "uid-alice",
      builderSlug: "alice",
      sizingTier: "medium",
      operatorAccess: {
        shellsEnabled: true,
        reason: "owned-runtime-gateway",
      },
      serviceAccountName: "octogee-gw-alice",
      serviceAccount: { create: true },
    });
    expect(gwWrite?.data).not.toHaveProperty("operatorReservation");
    expect(gatewayReleasesDocs["alice/1"]?.payload).toMatchObject({ imageTag: "abc1234" });

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
      (c) => c.collection === "gateways" && c.op === "doc.set",
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
  it("attaches sizing.tier from the durable root and marks it explicit", async () => {
    seedDurableGateway("bender", {
      heartbeat: { status: "ready", mountedCustomers: ["alice"] },
      root: {
        sizingTier: "large",
        profile: "operator",
        gatewayClass: "operator",
        imageProfile: "operator",
        ownerUid: "uid-bender",
        builderSlug: "bender",
      },
    });
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

  it("falls back to class-default tier when sizingTier is unset (resolvedFrom='class-default')", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: {
        profile: "operator",
        gatewayClass: "operator",
        imageProfile: "operator",
        ownerUid: "uid-default",
        builderSlug: "default",
      },
    });
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    const g = res.body.gateways.find((x: any) => x.gatewayId === "default");
    expect(g.sizing.tier).toBe("small");
    expect(g.sizing.resolvedFrom).toBe("class-default");
  });

  it("reports compute=0 for paused gateways (no replicas → no node consumption)", async () => {
    seedDurableGateway("paused", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: { sizingTier: "large", desiredStatus: "paused" },
    });
    seedDurableGateway("running", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: { sizingTier: "large" },
    });
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    const paused = res.body.gateways.find((g: any) => g.gatewayId === "paused");
    const running = res.body.gateways.find((g: any) => g.gatewayId === "running");
    expect(paused.sizing.tier).toBe("large");
    expect(paused.sizing.monthlyCostUsd.compute).toBe(0);
    expect(paused.sizing.monthlyCostUsd.perBuilderAtTarget).toBe(0);
    expect(running.sizing.monthlyCostUsd.compute).toBeGreaterThan(0);
    expect(res.body.stats.fleetCost.monthlyUsd).toBe(running.sizing.monthlyCostUsd.compute);
  });

  it("drops any legacy persistence to emptyDir and keeps the PROD operator Spot reservation default", async () => {
    seedDurableGateway("bender", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: {
        gatewayClass: "operator",
        profile: "operator",
        imageProfile: "operator",
        ownerUid: "uid-bender",
        builderSlug: "bender",
        sizingTier: "nano",
        persistence: {
          enabled: true,
          storageClassName: "premium-rwo",
          size: "20Gi",
          accessModes: ["ReadWriteOnce"],
        },
      },
    });
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    const bender = res.body.gateways.find((g: any) => g.gatewayId === "bender");
    expect(bender.storage).toMatchObject({ mode: "emptyDir", pvcName: null });
    expect(bender.reservation).toMatchObject({
      type: "spot",
      computeClass: "octogee-gateway-spot",
    });
    expect(bender.sizing.monthlyCostUsd.compute).toBeLessThan(
      bender.sizing.monthlyCostUsd.onDemandCompute,
    );
    expect(res.body.stats.fleetCost.savingsUsd).toBeGreaterThan(0);
  });

  it("keeps on-demand pricing when a gateway is explicitly on the on-demand compute class", async () => {
    seedDurableGateway("dedicated", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: { sizingTier: "nano", computeClass: "octogee-gateway" },
    });
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    const dedicated = res.body.gateways.find((g: any) => g.gatewayId === "dedicated");
    expect(dedicated.storage).toMatchObject({ mode: "emptyDir", pvcName: null });
    expect(dedicated.reservation).toMatchObject({
      type: "on-demand",
      computeClass: "octogee-gateway",
    });
    expect(dedicated.sizing.monthlyCostUsd.compute).toBe(
      dedicated.sizing.monthlyCostUsd.onDemandCompute,
    );
    expect(dedicated.sizing.monthlyCostUsd.savings).toBe(0);
  });

  it("defaults shared gateways to Spot pricing", async () => {
    seedDurableGateway("shared", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: { sizingTier: "nano" },
    });
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    const shared = res.body.gateways.find((g: any) => g.gatewayId === "shared");
    expect(shared.reservation).toMatchObject({
      type: "spot",
      computeClass: "octogee-gateway-spot",
    });
    expect(shared.sizing.monthlyCostUsd.compute).toBeLessThan(
      shared.sizing.monthlyCostUsd.onDemandCompute,
    );
    expect(res.body.stats.fleetCost.savingsUsd).toBeGreaterThan(0);
  });

  it("rolls up stats.fleetCost.byTier and stats.fleetCost.monthlyUsd across the fleet", async () => {
    seedDurableGateway("bender", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: { sizingTier: "large" },
    });
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: { sizingTier: "medium" },
    });
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
  it("rejects an imageTag field on an existing durable root", async () => {
    seedDurableGateway("canary");
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ imageTag: "def5678" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/immutable releases/i);
    expect(gatewayReleasesDocs["canary/1"].payload).toMatchObject({ imageTag: "abc1234" });
  });

  it("returns 404 when the gateway does not exist", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/gw-missing")
      .send({ imageTag: "x" });
    expect(res.status).toBe(404);
  });

  it("rejects unknown desiredStatus enum values with 400 (does not write garbage to Firestore)", async () => {
    seedDurableGateway("canary");
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ desiredStatus: "burning" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/desiredStatus/);
    const update = calls.find(
      (c) => c.collection === "gateways" && c.op === "doc.update",
    );
    expect(update).toBeUndefined();
  });

  it("rejects desiredStatus=retired — retirement must go through DELETE for full teardown", async () => {
    seedDurableGateway("canary");
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ desiredStatus: "retired" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/DELETE \/gateways\/:id/);
    const update = calls.find(
      (c) => c.collection === "gateways" && c.op === "doc.update",
    );
    expect(update).toBeUndefined();
  });

  it("accepts desiredStatus=paused for the pause/resume flow", async () => {
    seedDurableGateway("canary");
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ desiredStatus: "paused" });
    expect(res.status).toBe(202);
    const update = calls.find(
      (c) => c.collection === "gateways" && c.op === "doc.update",
    );
    expect(update?.data).toMatchObject({ desiredStatus: "paused" });
  });

  it("updates the sizingTier field when a valid tier is supplied", async () => {
    seedDurableGateway("canary");
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ sizingTier: "large" });
    expect(res.status).toBe(202);
    const update = calls.find(
      (c) => c.collection === "gateways" && c.op === "doc.update",
    );
    expect(update?.data).toMatchObject({ sizingTier: "large" });
  });

  it("rejects unknown sizingTier values with 400 (does not write garbage to Firestore)", async () => {
    seedDurableGateway("canary");
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ sizingTier: "bogus-tier" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/durable gateway configuration/);
    const update = calls.find(
      (c) => c.collection === "gateways" && c.op === "doc.update",
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
  it("atomically claims a converged gateway for retirement when no customers are mounted", async () => {
    seedRetirableGateway("canary");
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/canary");
    expect(res.status).toBe(202);
    const update = calls.find(
      (c) => c.collection === "gateways" && c.op === "doc.set",
    );
    expect(update?.data).toMatchObject({
      desiredStatus: "retired",
      retirementVersion: 1,
      retirementClaim: { operationId: res.body.operationId, version: 1 },
    });
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data).toMatchObject({
      kind: "retire-gateway",
      createdBy: "admin-user",
      input: { gatewayId: "canary", retirementClaimVersion: 1 },
    });
  });

  it("defaults to full teardown — no retain flags on the retire-gateway op", async () => {
    seedRetirableGateway("canary");
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
    seedRetirableGateway("canary");
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
    seedDurableGateway("canary", {
      heartbeat: { status: "ready", mountedCustomers: ["alice", "bob"] },
    });
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/canary");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still has mounted customers/i);
    expect(res.body.mountedCustomers).toEqual(["alice", "bob"]);
    const update = calls.find(
      (c) => c.collection === "gateways" && c.op === "doc.update",
    );
    expect(update).toBeUndefined();
  });

  it("fails closed when the live revision telemetry is unavailable", async () => {
    seedRetirableGateway("orphan");
    delete glmGatewaysDocs["orphan-r1"];
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/orphan");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/live revision telemetry is unavailable/i);
    expect(gatewaysDocs.orphan).toMatchObject({ desiredStatus: "running" });
    expect(glmOperationsDocs.find((d) => d.data.kind === "retire-gateway")).toBeUndefined();
  });

  it("commits retirement claim + op create in one transaction", async () => {
    seedRetirableGateway("canary");
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/canary");
    expect(res.status).toBe(202);

    const updateIdx = calls.findIndex(
      (c) => c.collection === "gateways" && c.op === "doc.set",
    );
    const opIdx = calls.findIndex((c) => c.collection === "glmOperations");
    const commitIdx = calls.findIndex((c) => c.op === "transaction.commit");
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(opIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(updateIdx);
    expect(commitIdx).toBeGreaterThan(opIdx);
  });

  it("rolls back both claim writes if the transaction commit fails", async () => {
    seedRetirableGateway("canary");
    transactionCommitFailures = 1;
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/canary");
    expect(res.status).toBe(500);
    
    expect(gatewaysDocs["canary"]).toMatchObject({ desiredStatus: "running" });
    expect(glmOperationsDocs.find((d) => d.data.kind === "retire-gateway")).toBeUndefined();
  });

});

describe("POST /api/admin/gateways/:id/rollout — bump gateway image", () => {
  it("creates a rollout op with the new imageTag (and inherited repo)", async () => {
    seedDurableGateway("default", { imageTag: "abcdef0" });
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
    expect(gatewaysDocs.default).toMatchObject({ latestRelease: 2, desiredRelease: 2 });
    expect(gatewayReleasesDocs["default/2"]?.payload).toMatchObject({ imageTag: "abcdef1" });
  });

  it("rejects profile updates on rollout because configuration belongs on PATCH", async () => {
    seedDurableGateway("bender", { imageTag: "abcdef1" });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/bender/rollout")
      .send({ imageTag: "abcdef1", profile: "operator" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/configuration is mutable/i);
    expect(calls.find((c) => c.collection === "glmOperations")).toBeUndefined();
  });

  it("rejects a profile rollout before checking the image no-op boundary", async () => {
    seedDurableGateway("bender", {
      imageTag: "abcdef1",
      root: { profile: "operator", gatewayClass: "operator", ownerUid: "uid-bender" },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/bender/rollout")
      .send({ imageTag: "abcdef1", profile: "operator" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/configuration is mutable/i);
    expect(calls.find((c) => c.collection === "glmOperations")).toBeUndefined();
  });

  it("rejects an unknown profile with 400 (no op written)", async () => {
    seedDurableGateway("default", { imageTag: "abcdef0" });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/default/rollout")
      .send({ imageTag: "abcdef1", profile: "root" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/profile/);
    expect(calls.find((c) => c.collection === "glmOperations")).toBeUndefined();
  });

  it("returns 400 when imageTag is not a SHA-style hex string (e.g. 'latest', 'v1.2.3')", async () => {
    seedDurableGateway("default", { imageTag: "abcdef0" });
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
    seedDurableGateway("default", { imageTag: "abcdef0" });
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
    seedDurableGateway("default", { imageTag: "abcdef0" });
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways/default/rollout").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/imageTag/);
  });

  it("returns 400 when imageRepository is not the canonical Octogee AR repo", async () => {
    seedDurableGateway("default", { imageTag: "abcdef0" });
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
    seedDurableGateway("default", { imageTag: "1234567" });
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
  it("creates a restart-gateway operation (kind carried in input)", async () => {
    seedDurableGateway("bender", { imageTag: "abcdef1" });
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
    seedDurableGateway("bender", {
      imageTag: "abcdef1",
      heartbeat: { status: "ready", mountedCustomers: ["alice", "bob"] },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/bender/restart")
      .send({});
    expect(res.status).toBe(202);
  });

  it("returns 409 when another op is already pending or running for this gateway", async () => {
    seedDurableGateway("bender", { imageTag: "abcdef1" });
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
    seedDurableGateway("canary", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs["uid-alice"] = {
      username: "alice",
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/migrate")
      .send({ to: "canary" });
    expect(res.status).toBe(202);
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data).toMatchObject({
      kind: "migrate-customer",
      status: "pending",
      input: {
        uid: "uid-alice",
        builderSlug: "alice",
        fromGatewayId: "default",
        toGatewayId: "canary",
      },
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
    seedDurableGateway("gw-booting", {
      heartbeat: { status: "booting", mountedCustomers: [] },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/migrate")
      .send({ to: "gw-booting" });
    expect(res.status).toBe(409);
  });

  it("returns 409 when the target equals the customer's current gateway (migrate-to-self)", async () => {
    seedDurableGateway("canary", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
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

  it("returns 409 with the blocking op while a migration for the customer is already pending or running (Retry double-click)", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    };
    glmOperationsDocs.unshift({
      id: "op-mig-live",
      data: {
        kind: "migrate-customer",
        status: "pending",
        inputUid: "uid-alice",
        input: { uid: "uid-alice", toGatewayId: "canary" },
      },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/migrate")
      .send({ to: "canary" });
    expect(res.status).toBe(409);
    expect(res.body.operationId).toBe("op-mig-live");
    const created = calls.find((c) => c.collection === "glmOperations" && c.op === "add");
    expect(created).toBeUndefined();
  });
});

describe("POST /api/admin/customers/:uid/unassign — clear assignment, let reconcile evict", () => {
  it("clears provisioning.openclaw.gatewayId and reports where the customer was", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      provisioning: { openclaw: { slug: "alice", gatewayId: "default-green" } },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/unassign")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unassigned: true, uid: "uid-alice", from: "default-green" });
    const update = calls.find(
      (c) => c.collection === "users" && c.op === "doc.update" && c.docId === "uid-alice",
    );
    expect(update?.data?.["provisioning.openclaw.gatewayId"]).toEqual(FieldValue.delete());
    expect(update?.data?.["provisioning.openclaw.gatewayAssignedAt"]).toEqual(FieldValue.delete());
    expect(update?.data?.["provisioning.openclaw.gatewayProfile"]).toEqual(FieldValue.delete());
    expect(update?.data?.["provisioning.openclaw.shellsEnabled"]).toEqual(FieldValue.delete());
  });

  it("returns 404 for an unknown customer", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-ghost/unassign")
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 409 when the customer is already unassigned", async () => {
    usersDocs["uid-alice"] = { username: "alice", provisioning: { openclaw: { slug: "alice" } } };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/unassign")
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already unassigned/i);
  });

  it("returns 409 while a migration for the customer is pending or running", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      provisioning: { openclaw: { slug: "alice", gatewayId: "default-green" } },
    };
    glmOperationsDocs.unshift({
      id: "op-mig-1",
      data: {
        kind: "migrate-customer",
        status: "running",
        inputUid: "uid-alice",
        input: { uid: "uid-alice", toGatewayId: "default-blue" },
      },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/unassign")
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.operationId).toBe("op-mig-1");
    const update = calls.find((c) => c.collection === "users" && c.op === "doc.update");
    expect(update).toBeUndefined();
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
  it("buckets every builder into mounted / assigned-not-mounted / unassigned", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: ["alice", "bob"] },
    });
    usersDocs = {
      "uid-alice": {
        username: "alice",
        email: "alice@example.com",
        provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
      },
      "uid-bob": {
        username: "bob",
        email: "bob@example.com",
        provisioning: { openclaw: { slug: "bob", gatewayId: "default" } },
      },
      "uid-carol": {
        username: "carol",
        email: "carol@example.com",
        provisioning: { openclaw: { slug: "carol", gatewayId: "default" } },
      },
      "uid-dave": {
        username: "dave",
        email: "dave@example.com",
        provisioning: {},
      },
      "uid-eve": {
        username: "eve",
        email: "eve@example.com",
        provisioning: { openclaw: { slug: "eve", gatewayId: "default" } },
      },
    };
    const app = buildApp();
    const res = await request(app).get("/api/admin/customer-distribution");
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({
      totalBuilders: 5,
      assigned: 4,
      unassigned: 1,
      mounted: 2,
      assignedNotMounted: 2,
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
        assignedCount: 4,
        mountedCount: 2,
      }),
    ]);
  });

  it("flags users whose gateway no longer exists with reason='gateway-gone'", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs = {
      "uid-orphan": {
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

  it("returns empty buckets when no builders exist", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs = {};
    const app = buildApp();
    const res = await request(app).get("/api/admin/customer-distribution");
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({
      totalBuilders: 0,
      assigned: 0,
      unassigned: 0,
      mounted: 0,
    });
    expect(res.body.pendingPlacements).toEqual([]);
  });
});

describe("POST /api/admin/customers/:uid/assign — initial placement", () => {
  it("writes placement without a separate eligibility field", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs = {
      "uid-dave": { username: "dave", email: "dave@example.com" },
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
    seedDurableGateway("gw-operator", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: {
        profile: "operator",
        gatewayClass: "operator",
        imageProfile: "operator",
        ownerUid: "uid-owner",
        builderSlug: "owner",
        operatorAccess: {
          shellsEnabled: true,
          reason: "owned-runtime-gateway",
        },
      },
    });
    usersDocs = {
      "uid-dave": { username: "dave", email: "dave@example.com" },
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

  it("returns 404 when the target gateway is not registered", async () => {
    usersDocs = { "uid-dave": { username: "dave" } };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-dave/assign")
      .send({ gatewayId: "gw-missing" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/gateway not found/);
  });

  it("returns 409 when the target gateway is not ready (booting/unreachable/draining)", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "booting", mountedCustomers: [] },
    });
    usersDocs = { "uid-dave": { username: "dave" } };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-dave/assign")
      .send({ gatewayId: "default" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not ready/);
  });

  it("repairs a missing durable assignment when the mirror already targets that gateway", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs = {
      "uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
      },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/assign")
      .send({ gatewayId: "default" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ repaired: true, gatewayId: "default" });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        collection: "gateways/default/assignments",
        op: "doc.set",
        docId: "uid-alice",
        data: expect.objectContaining({ source: "repair", slug: "alice" }),
      }),
    ]));
  });

  it("preserves an in-flight assignment when same-target repair races a roll", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs = {
      "uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
      },
    };
    const existing = {
      uid: "uid-alice",
      slug: "alice",
      gatewayId: "default",
      revisionId: "default-r1",
      release: 1,
      source: "migration",
      state: "quiescing",
      epoch: 7,
      updatedAt: 90,
      updatedByOperationId: "roll-default-r2",
    };
    gatewayAssignmentsDocs["default/uid-alice"] = existing;

    const res = await request(buildApp())
      .post("/api/admin/customers/uid-alice/assign")
      .send({ gatewayId: "default" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(gatewayAssignmentsDocs["default/uid-alice"]).toEqual(existing);
    expect(calls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        collection: "gateways/default/assignments",
        op: "doc.set",
        docId: "uid-alice",
      }),
    ]));
  });

  it("rejects assignment when the builder has no canonical slug", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs = {
      "uid-orphan": {
        provisioning: { openclaw: { gatewayId: "default" } },
      },
    };

    const res = await request(buildApp())
      .post("/api/admin/customers/uid-orphan/assign")
      .send({ gatewayId: "default" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/canonical slug/i);
    expect(gatewayAssignmentsDocs["default/uid-orphan"]).toBeUndefined();
  });
});

describe("GET /api/admin/gateways/:id/details — drawer payload", () => {
  it("returns mounted-customer details + recent ops for the gateway", async () => {
    seedDurableGateway("default", {
      imageTag: "abc1234",
      heartbeat: { status: "ready", mountedCustomers: ["alice", "bob"] },
    });
    usersDocs = {
      "uid-alice": {
        username: "alice",
        email: "alice@octogee.com",
        throttleLevel: 0,
        lastActive: "2026-05-04T09:00:00Z",
        provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
      },
      "uid-bob": {
        username: "bob",
        email: "bob@octogee.com",
        throttleLevel: 2,
        lastActive: "2026-05-04T08:30:00Z",
        provisioning: { openclaw: { slug: "bob", gatewayId: "default" } },
      },
      "uid-carol": {
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
    });
    expect(res.body.recentOperations).toHaveLength(1);
    expect(res.body.recentOperations[0].id).toBe("op-this-gw");
    expect(res.body.generatedAt).toBeTruthy();
  });

  it("returns empty mountedCustomers when the gateway heartbeat doc has no mounts", async () => {
    seedDurableGateway("gw-empty", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
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
    seedDurableGateway("gw-booting");
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways/gw-booting/details");
    expect(res.status).toBe(200);
    expect(res.body.mountedCustomers).toEqual([]);
  });

  it("only returns operations whose input.gatewayId matches the path id", async () => {
    seedDurableGateway("default");
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
