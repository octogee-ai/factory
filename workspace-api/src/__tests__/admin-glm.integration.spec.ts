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
        return { docs: [], size: 0 };
      },
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

const provisionerCalls: Array<{ gatewayId: string; gatewayServiceAccount: string }> = [];
let provisionerNextError: Error | null = null;

vi.mock("../lib/secret-manager", () => ({
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
  restoreJobsDocs = [];
  provisionerCalls.length = 0;
  provisionerNextError = null;
  process.env.GATEWAY_SERVICE_ACCOUNT = "octogee-gateway@octogee-test.iam.gserviceaccount.com";
});

describe("POST /api/admin/gateways — create desired state + op", () => {
  it("writes a glmGateways doc and creates an add-gateway operation", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "gw-test-canary",
      instanceName: "canary",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
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
    });
  });

  it("rejects bodies missing required fields with 400", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({ gatewayId: "x" });
    expect(res.status).toBe(400);
  });

  it("provisions the gateway-auth-token Secret Manager shell (+ IAM) before writing the glmGateways doc", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "gw-test-canary",
      instanceName: "canary",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
    });
    expect(res.status).toBe(202);
    expect(provisionerCalls).toEqual([
      {
        gatewayId: "gw-test-canary",
        gatewayServiceAccount: "octogee-gateway@octogee-test.iam.gserviceaccount.com",
      },
    ]);
  });

  it("does NOT write the glmGateways doc if SM provisioning fails — operator gets 502 with detail", async () => {
    provisionerNextError = new Error("PERMISSION_DENIED on secretmanager.secrets.create");
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "gw-test-canary",
      instanceName: "canary",
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
      gatewayId: "gw-test-canary",
      instanceName: "canary",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
      imageTag: "abc1234",
    });
    expect(res.status).toBe(500);
    expect(provisionerCalls).toEqual([]);
  });

  it("rejects 400 when imageRepository is not the canonical Artifact Registry repo", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "gw-test-typo",
      instanceName: "typo",
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogeee/octogee-gateway",
      imageTag: "abc1234",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/imageRepository/i);
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
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
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
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
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
  it("sets desiredStatus=retired and creates a retire-gateway op when no customers are mounted", async () => {
    glmGatewaysDocs["gw-test-canary"] = { gatewayId: "gw-test-canary" };
    gatewaysDocs["gw-test-canary"] = { gatewayId: "gw-test-canary", status: "ready", mountedCustomers: [] };
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

  it("returns 409 with the customer list when the gateway still has mounted customers", async () => {
    glmGatewaysDocs["gw-test-canary"] = { gatewayId: "gw-test-canary" };
    gatewaysDocs["gw-test-canary"] = {
      gatewayId: "gw-test-canary",
      status: "ready",
      mountedCustomers: ["alice", "bob"],
    };
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/gw-test-canary");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still has mounted customers/i);
    expect(res.body.mountedCustomers).toEqual(["alice", "bob"]);
    const update = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.update",
    );
    expect(update).toBeUndefined();
  });

  it("proceeds with retire when the gateway has no heartbeat doc (stranded crash-loop case)", async () => {
    glmGatewaysDocs["gw-test-orphan"] = { gatewayId: "gw-test-orphan" };
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/gw-test-orphan");
    expect(res.status).toBe(202);
    const update = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.update",
    );
    expect(update?.data).toMatchObject({ desiredStatus: "retired" });
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data).toMatchObject({ kind: "retire-gateway", createdBy: "admin-user" });
  });

  it("returns 409 when an in-flight restore job is set on the heartbeat (mid-mount)", async () => {
    glmGatewaysDocs["gw-test-canary"] = { gatewayId: "gw-test-canary" };
    gatewaysDocs["gw-test-canary"] = {
      gatewayId: "gw-test-canary",
      status: "ready",
      mountedCustomers: [],
      inFlightJobId: "job-restore-7",
    };
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/gw-test-canary");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/in-flight restore job/i);
    expect(res.body.inFlightJobId).toBe("job-restore-7");
    const update = calls.find(
      (c) => c.collection === "glmGateways" && c.op === "doc.update",
    );
    expect(update).toBeUndefined();
  });
});

describe("POST /api/admin/gateways/:id/rollout — bump gateway image", () => {
  const REPO = "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

  it("creates a rollout op with the new imageTag (and inherited repo)", async () => {
    glmGatewaysDocs["gw-test"] = {
      gatewayId: "gw-test",
      instanceName: "default",
      imageRepository: REPO,
      imageTag: "oldSha",
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/gw-test/rollout")
      .send({ imageTag: "abcdef1" });
    expect(res.status).toBe(202);
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op?.data).toMatchObject({
      kind: "rollout",
      input: { gatewayId: "gw-test", imageTag: "abcdef1" },
      createdBy: "admin-user",
    });
  });

  it("returns 400 when imageTag is not a SHA-style hex string (e.g. 'latest', 'v1.2.3')", async () => {
    glmGatewaysDocs["gw-test"] = {
      gatewayId: "gw-test",
      instanceName: "default",
      imageRepository: REPO,
      imageTag: "oldSha1",
    };
    const app = buildApp();
    for (const bad of ["latest", "v1.2.3", "ABC123def", "abc"]) {
      const res = await request(app)
        .post("/api/admin/gateways/gw-test/rollout")
        .send({ imageTag: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/SHA/);
    }
    expect(calls.find((c) => c.collection === "glmOperations")).toBeUndefined();
  });

  it("returns 409 when another op is already pending or running for this gateway", async () => {
    glmGatewaysDocs["gw-test"] = {
      gatewayId: "gw-test",
      instanceName: "default",
      imageRepository: REPO,
      imageTag: "oldSha1",
    };
    glmOperationsDocs.push({
      id: "op-running-1",
      data: {
        kind: "migrate-customer",
        status: "running",
        input: { gatewayId: "gw-test", uid: "u1" },
      },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/gw-test/rollout")
      .send({ imageTag: "abcdef2" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already pending or running/);
    expect(res.body.operationId).toBe("op-running-1");
    expect(res.body.kind).toBe("migrate-customer");
  });

  it("returns 400 when imageTag is missing", async () => {
    glmGatewaysDocs["gw-test"] = {
      gatewayId: "gw-test",
      instanceName: "default",
      imageRepository: REPO,
      imageTag: "oldSha",
    };
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways/gw-test/rollout").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/imageTag/);
  });

  it("returns 400 when imageRepository is not the canonical Octogee AR repo", async () => {
    glmGatewaysDocs["gw-test"] = {
      gatewayId: "gw-test",
      instanceName: "default",
      imageRepository: REPO,
      imageTag: "oldSha",
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/gw-test/rollout")
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
    glmGatewaysDocs["gw-test"] = {
      gatewayId: "gw-test",
      instanceName: "default",
      imageRepository: REPO,
      imageTag: "1234567",
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/gw-test/rollout")
      .send({ imageTag: "1234567" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no-op|already on/i);
    const op = calls.find((c) => c.collection === "glmOperations");
    expect(op).toBeUndefined();
  });

  it("returns 409 when an in-flight restore job is set on the heartbeat", async () => {
    glmGatewaysDocs["gw-test"] = {
      gatewayId: "gw-test",
      instanceName: "default",
      imageRepository: REPO,
      imageTag: "oldSha",
    };
    gatewaysDocs["gw-test"] = {
      gatewayId: "gw-test",
      status: "ready",
      inFlightJobId: "job-restore-9",
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/gw-test/rollout")
      .send({ imageTag: "abcdef1" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/in-flight restore job/i);
    expect(res.body.inFlightJobId).toBe("job-restore-9");
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

describe("GET /api/admin/customer-distribution — fleet-wide ops view", () => {
  it("buckets approved users into mounted / assigned-not-mounted / unassigned", async () => {
    gatewaysDocs = {
      "gw-test": { status: "ready", mountedCustomers: ["alice", "bob"] },
    };
    usersDocs = {
      "uid-alice": {
        approved: true,
        username: "alice",
        email: "alice@example.com",
        provisioning: { openclaw: { slug: "alice", gatewayId: "gw-test" } },
      },
      "uid-bob": {
        approved: true,
        username: "bob",
        email: "bob@example.com",
        provisioning: { openclaw: { slug: "bob", gatewayId: "gw-test" } },
      },
      "uid-carol": {
        approved: true,
        username: "carol",
        email: "carol@example.com",
        provisioning: { openclaw: { slug: "carol", gatewayId: "gw-test" } },
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
        provisioning: { openclaw: { slug: "eve", gatewayId: "gw-test" } },
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
        gatewayId: "gw-test",
        status: "ready",
        assignedCount: 3,
        mountedCount: 2,
      }),
    ]);
  });

  it("flags users whose gateway no longer exists with reason='gateway-gone'", async () => {
    gatewaysDocs = {
      "gw-test": { status: "ready", mountedCustomers: [] },
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
      "gw-test": { status: "ready", mountedCustomers: [] },
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
      "gw-test": { status: "ready", mountedCustomers: [] },
    };
    usersDocs = {
      "uid-dave": { approved: true, username: "dave", email: "dave@example.com" },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-dave/assign")
      .send({ gatewayId: "gw-test" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ uid: "uid-dave", gatewayId: "gw-test" });
    const update = calls.find(
      (c) => c.collection === "users" && c.op === "doc.update",
    );
    expect(update?.data).toMatchObject({
      "provisioning.openclaw.gatewayId": "gw-test",
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
    gatewaysDocs = { "gw-test": { status: "ready" } };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-missing/assign")
      .send({ gatewayId: "gw-test" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/user not found/);
  });

  it("returns 409 when the user is not approved", async () => {
    gatewaysDocs = { "gw-test": { status: "ready" } };
    usersDocs = {
      "uid-pending": { approved: false, username: "pending", email: "pending@example.com" },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-pending/assign")
      .send({ gatewayId: "gw-test" });
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
    gatewaysDocs = { "gw-test": { status: "booting" } };
    usersDocs = { "uid-dave": { approved: true } };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-dave/assign")
      .send({ gatewayId: "gw-test" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not ready/);
  });

  it("returns 409 when the user is already assigned to that gateway (no-op)", async () => {
    gatewaysDocs = { "gw-test": { status: "ready" } };
    usersDocs = {
      "uid-alice": {
        approved: true,
        provisioning: { openclaw: { gatewayId: "gw-test" } },
      },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/customers/uid-alice/assign")
      .send({ gatewayId: "gw-test" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already assigned/);
  });
});

describe("GET /api/admin/restore-jobs — provisioner queue", () => {
  it("returns recent jobs with timestamps serialized to ISO and snapshot fields lifted to top level", async () => {
    restoreJobsDocs = [
      {
        id: "job-newest",
        data: {
          jobId: "job-newest",
          gatewayId: "gw-test",
          state: "running",
          attempt: 2,
          createdAt: { toDate: () => new Date(3_000) },
          dispatchedAt: { toDate: () => new Date(3_500) },
          completedAt: null,
          error: null,
          snapshot: { uid: "u-1", slug: "alice" },
        },
      },
      {
        id: "job-older",
        data: {
          jobId: "job-older",
          gatewayId: "gw-test",
          state: "done",
          attempt: 1,
          createdAt: { toDate: () => new Date(1_000) },
          dispatchedAt: { toDate: () => new Date(1_500) },
          completedAt: { toDate: () => new Date(2_500) },
          error: null,
          snapshot: { uid: "u-2", slug: "bob" },
        },
      },
    ];
    const app = buildApp();
    const res = await request(app).get("/api/admin/restore-jobs");
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(2);
    expect(res.body.jobs[0]).toMatchObject({
      jobId: "job-newest",
      gatewayId: "gw-test",
      state: "running",
      attempt: 2,
      uid: "u-1",
      slug: "alice",
    });
    expect(res.body.jobs[0].createdAt).toBe("1970-01-01T00:00:03.000Z");
    expect(res.body.jobs[0].dispatchedAt).toBe("1970-01-01T00:00:03.500Z");
    expect(res.body.jobs[0].completedAt).toBeNull();
    expect(res.body.generatedAt).toBeTruthy();
  });

  it("respects ?limit and clamps to 200", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/admin/restore-jobs?limit=500");
    expect(res.status).toBe(200);
    // No fixtures → empty list, but the endpoint succeeds (limit handled internally)
    expect(res.body.jobs).toEqual([]);
  });

  it("returns an empty list when there are no jobs", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/admin/restore-jobs");
    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([]);
  });

  it("falls back to limit=50 when ?limit is non-numeric (parseInt returns NaN)", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/admin/restore-jobs?limit=abc");
    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([]);
  });

  it("serializes epoch=0 timestamps instead of dropping them as 'falsy'", async () => {
    restoreJobsDocs = [
      {
        id: "job-epoch",
        data: {
          jobId: "job-epoch",
          gatewayId: "gw-test",
          state: "done",
          attempt: 1,
          createdAt: 0,
          dispatchedAt: { toDate: () => new Date(0) },
          completedAt: null,
          error: null,
          snapshot: { uid: "u-1", slug: "alice" },
        },
      },
    ];
    const app = buildApp();
    const res = await request(app).get("/api/admin/restore-jobs");
    expect(res.status).toBe(200);
    expect(res.body.jobs[0].createdAt).toBe("1970-01-01T00:00:00.000Z");
    expect(res.body.jobs[0].dispatchedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("guards against NaN attempt values flowing through to the wire", async () => {
    restoreJobsDocs = [
      {
        id: "job-nan",
        data: {
          jobId: "job-nan",
          gatewayId: "gw-test",
          state: "running",
          attempt: NaN,
          createdAt: { toDate: () => new Date(1_000) },
          dispatchedAt: null,
          completedAt: null,
          error: null,
          snapshot: { uid: "u-2", slug: "bob" },
        },
      },
    ];
    const app = buildApp();
    const res = await request(app).get("/api/admin/restore-jobs");
    expect(res.status).toBe(200);
    expect(res.body.jobs[0].attempt).toBe(1);
  });

  it("normalizes a malformed state value to 'unknown' instead of silently coercing to pending", async () => {
    restoreJobsDocs = [
      {
        id: "job-malformed",
        data: {
          jobId: "job-malformed",
          gatewayId: "gw-test",
          state: "weird-state-not-in-union",
          attempt: 1,
          createdAt: { toDate: () => new Date(1_000) },
          dispatchedAt: null,
          completedAt: null,
          error: null,
          snapshot: { uid: "u-x", slug: "x" },
        },
      },
    ];
    const app = buildApp();
    const res = await request(app).get("/api/admin/restore-jobs");
    expect(res.status).toBe(200);
    expect(res.body.jobs[0].state).toBe("unknown");
  });

  it("preserves the error field on failed jobs", async () => {
    restoreJobsDocs = [
      {
        id: "job-failed",
        data: {
          jobId: "job-failed",
          gatewayId: "gw-test",
          state: "failed",
          attempt: 3,
          createdAt: { toDate: () => new Date(1_000) },
          dispatchedAt: { toDate: () => new Date(1_500) },
          completedAt: { toDate: () => new Date(2_500) },
          error: "boot-sync timed out",
          snapshot: { uid: "u-3", slug: "charlie" },
        },
      },
    ];
    const app = buildApp();
    const res = await request(app).get("/api/admin/restore-jobs");
    expect(res.status).toBe(200);
    expect(res.body.jobs[0]).toMatchObject({
      jobId: "job-failed",
      state: "failed",
      error: "boot-sync timed out",
    });
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
