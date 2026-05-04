import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FirestoreCall {
  collection: string;
  op: "add" | "doc.set" | "doc.update";
  docId?: string;
  data?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

const calls: FirestoreCall[] = [];
let glmOperationsDocs: Array<{ id: string; data: Record<string, unknown> }> = [];
let glmGatewaysDocs: Record<string, Record<string, unknown>> = {};
let gatewaysDocs: Record<string, Record<string, unknown>> = {};
let usersDocs: Record<string, Record<string, unknown>> = {};

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
        if (collectionName === "glmOperations" && !filter) {
          return {
            docs: glmOperationsDocs.map((d) => ({ id: d.id, data: () => d.data })),
            size: glmOperationsDocs.length,
          };
        }
        if (collectionName === "glmGateways" && filter) {
          const matches = Object.entries(glmGatewaysDocs)
            .filter(([, data]) => data[filter.field] === filter.value)
            .map(([id, data]) => ({ id, data: () => data }));
          return { docs: matches, size: matches.length };
        }
        if (collectionName === "users" && filter) {
          const matches = Object.entries(usersDocs)
            .filter(([, data]) => readNestedField(data, filter.field) === filter.value)
            .map(([id, data]) => ({ id, data: () => data }));
          return { docs: matches, size: matches.length };
        }
        return { docs: [], size: 0 };
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
      doc: (docId: string) => ({
        id: docId,
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
          return { exists: true, data: () => ({}) };
        },
        set: async (data: Record<string, unknown>, options?: Record<string, unknown>) => {
          calls.push({ collection: name, op: "doc.set", docId, data, options });
          if (name === "glmGateways") glmGatewaysDocs[docId] = data;
        },
        update: async (data: Record<string, unknown>) => {
          calls.push({ collection: name, op: "doc.update", docId, data });
          if (name === "glmGateways" && glmGatewaysDocs[docId]) {
            glmGatewaysDocs[docId] = { ...glmGatewaysDocs[docId], ...data };
          }
        },
      }),
      orderBy: () => whereChain(name),
      where: (field: string, _op: string, value: unknown) =>
        whereChain(name, { field, value }),
      limit: () => whereChain(name),
      get: async () => ({ docs: [], size: 0 }),
    };
  }

  return {
    db: {
      collection,
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

vi.mock("../middleware/auth", () => ({
  // Mirrors the real middleware: requireAdmin populates `req.uid`
  // (canonical) and `req.user` (Firestore user doc — does NOT carry uid
  // as a field). Tests that read req.user.uid would silently pass while
  // production reads "unknown".
  requireAdmin: (req: any, _res: any, next: any) => {
    req.uid = "admin-user";
    req.user = { email: "admin@octogee.com" };
    next();
  },
  requireAuth: (req: any, _res: any, next: any) => {
    req.uid = "admin-user";
    req.user = { email: "admin@octogee.com" };
    next();
  },
}));

import express from "express";
import adminRouter from "../routes/admin";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return app;
}

beforeEach(() => {
  calls.length = 0;
  glmOperationsDocs = [];
  glmGatewaysDocs = {};
  gatewaysDocs = { "gw-test-canary": { gatewayId: "gw-test-canary", status: "ready" } };
  usersDocs = {};
});

describe("POST /api/admin/gateways — create desired state + op", () => {
  it("writes a glmGateways doc and creates an add-gateway operation", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "gw-test-canary",
      instanceName: "canary",
      imageRepository: "repo/octogee-gateway",
      imageTag: "abc1234",
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ gatewayId: "gw-test-canary" });
    expect(res.body.operationId).toBeTruthy();

    const gwWrite = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.set",
    );
    expect(gwWrite?.docId).toBe("gw-test-canary");
    expect(gwWrite?.data).toMatchObject({
      gatewayId: "gw-test-canary",
      instanceName: "canary",
      imageRepository: "repo/octogee-gateway",
      imageTag: "abc1234",
      desiredStatus: "running",
      createdBy: "admin-user",
    });

    const opWrite = calls.find((c) => c.collection === "glmOperations");
    expect(opWrite?.data).toMatchObject({
      kind: "add-gateway",
      status: "pending",
      createdBy: "admin-user",
    });
  });

  it("rejects bodies missing required fields with 400", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({ gatewayId: "x" });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the gatewayId already exists", async () => {
    glmGatewaysDocs["gw-existing"] = {
      gatewayId: "gw-existing",
      instanceName: "existing",
    };
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "gw-existing",
      instanceName: "another",
      imageRepository: "repo/x",
      imageTag: "v1",
    });
    expect(res.status).toBe(409);
  });

  it("returns 409 when another gateway already uses the same instanceName", async () => {
    glmGatewaysDocs["gw-existing"] = {
      gatewayId: "gw-existing",
      instanceName: "default",
    };
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "gw-new",
      instanceName: "default",
      imageRepository: "repo/x",
      imageTag: "v1",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/instanceName/);
  });
});

describe("PATCH /api/admin/gateways/:id — update desired state", () => {
  it("updates the imageTag field on an existing desired state doc", async () => {
    glmGatewaysDocs["gw-test-canary"] = { gatewayId: "gw-test-canary" };
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/gw-test-canary")
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
});

describe("DELETE /api/admin/gateways/:id — retire", () => {
  it("sets desiredStatus=retired and creates a retire-gateway op", async () => {
    glmGatewaysDocs["gw-test-canary"] = { gatewayId: "gw-test-canary" };
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/gw-test-canary");
    expect(res.status).toBe(202);
    const update = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.update",
    );
    expect(update?.data).toMatchObject({ desiredStatus: "retired" });
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data).toMatchObject({ kind: "retire-gateway", createdBy: "admin-user" });
  });

  it("returns 404 when the gateway does not exist", async () => {
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/gw-missing");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/customers/:uid/migrate — start migration", () => {
  it("creates a migrate-customer operation", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/migrate")
      .send({ to: "gw-test-canary" });
    expect(res.status).toBe(202);
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data).toMatchObject({
      kind: "migrate-customer",
      status: "pending",
      input: { uid: "uid-alice", toGatewayId: "gw-test-canary" },
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
      provisioning: { openclaw: { slug: "alice", gatewayId: "gw-test-canary" } },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/migrate")
      .send({ to: "gw-test-canary" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
  });
});

describe("POST /api/admin/rollouts — composite operation", () => {
  it("creates a rollout operation with the source gateway + target image", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/rollouts").send({
      fromGatewayId: "gw-test-default",
      imageTag: "def5678",
    });
    expect(res.status).toBe(202);
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data).toMatchObject({
      kind: "rollout",
      status: "pending",
      input: { fromGatewayId: "gw-test-default", imageTag: "def5678" },
      createdBy: "admin-user",
    });
  });
});

describe("GET /api/admin/customers/by-slug/:slug — slug→uid lookup", () => {
  it("returns uid + currentGatewayId for a slug stored at provisioning.openclaw.slug", async () => {
    usersDocs["uid-alice"] = {
      provisioning: { openclaw: { slug: "alice", gatewayId: "gw-test-canary" } },
    };
    const app = buildApp();
    const res = await request(app).get("/api/admin/customers/by-slug/alice");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uid: "uid-alice", currentGatewayId: "gw-test-canary" });
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
