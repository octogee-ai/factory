import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FsCall {
  collection: string;
  op: "add" | "doc.delete" | "doc.update" | "batch.set" | "batch.update" | "batch.delete";
  docId?: string;
  data?: Record<string, unknown>;
}

const fsCalls: FsCall[] = [];
let usersDocs: Record<string, Record<string, unknown>> = {};
let glmOperationsDocs: Array<{ id: string; data: Record<string, unknown> }> = [];
const authDisabledUids: string[] = [];
const authRevokedUids: string[] = [];
let authNextError: Error | null = null;
const loggedWarnings: string[] = [];

vi.mock("../lib/db", () => {
  let autoId = 0;
  function whereChain(
    collectionName: string,
    filters: Array<{ field: string; value: unknown }> = [],
  ) {
    return {
      where: (field: string, _op: string, value: unknown) =>
        whereChain(collectionName, [...filters, { field, value }]),
      orderBy: () => whereChain(collectionName, filters),
      limit: () => whereChain(collectionName, filters),
      get: async () => {
        if (collectionName === "glmOperations") {
          const docs = glmOperationsDocs.filter((d) =>
            filters.every((f) => {
              const v = d.data[f.field];
              if (Array.isArray(f.value)) {
                return (f.value as unknown[]).includes(v);
              }
              return v === f.value;
            }),
          );
          return {
            docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
            size: docs.length,
          };
        }
        return { docs: [], size: 0 };
      },
    };
  }

  function collection(name: string): any {
    return {
      add: async (data: Record<string, unknown>) => {
        const id = `op-${glmOperationsDocs.length + 1}`;
        fsCalls.push({ collection: name, op: "add", docId: id, data });
        if (name === "glmOperations") glmOperationsDocs.unshift({ id, data });
        return { id };
      },
      doc: (requestedId?: string) => {
        const docId = requestedId ?? `auto-${++autoId}`;
        return {
        id: docId,
        __collection: name,
        get: async () => {
          if (name === "users") {
            const data = usersDocs[docId];
            return { exists: data !== undefined, data: () => data };
          }
          return { exists: false, data: () => undefined };
        },
        collection: (sub: string) => collection(sub),
        delete: async () => {
          fsCalls.push({ collection: name, op: "doc.delete", docId });
          if (name === "users") delete usersDocs[docId];
        },
        update: async (data: Record<string, unknown>) => {
          fsCalls.push({ collection: name, op: "doc.update", docId, data });
        },
        };
      },
      where: (field: string, op: string, value: unknown) =>
        whereChain(name, [{ field, value }]),
      orderBy: () => whereChain(name),
      limit: () => whereChain(name),
      get: async () => ({ docs: [], size: 0 }),
    };
  }

  return {
    db: {
      collection,
      doc: () => ({}),
      getAll: async () => [],
      batch: () => ({
        set: (ref: { id: string; __collection?: string }, data: Record<string, unknown>) => {
          fsCalls.push({ collection: ref.__collection ?? "unknown", op: "batch.set", docId: ref.id, data });
        },
        update: (ref: { id: string; __collection?: string }, data: Record<string, unknown>) => {
          fsCalls.push({ collection: ref.__collection ?? "unknown", op: "batch.update", docId: ref.id, data });
        },
        delete: (ref: { id: string; __collection?: string }) => {
          fsCalls.push({ collection: ref.__collection ?? "unknown", op: "batch.delete", docId: ref.id });
        },
        commit: async () => undefined,
      }),
    },
    FieldValue: { serverTimestamp: () => "now", delete: () => "delete" },
    Timestamp: { now: () => ({ toDate: () => new Date() }) },
  };
});

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    updateUser: async (uid: string) => {
      if (authNextError) {
        const e = authNextError;
        authNextError = null;
        throw e;
      }
      authDisabledUids.push(uid);
    },
    revokeRefreshTokens: async (uid: string) => { authRevokedUids.push(uid); },
  }),
}));

vi.mock("../middleware/auth", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.uid = "admin-uid";
    req.user = { email: "admin@octogee.com" };
    next();
  },
  requireAuth: (req: any, _res: any, next: any) => {
    req.uid = "admin-uid";
    next();
  },
}));

vi.mock("../middleware/logging", () => ({
  logger: {
    info: () => undefined,
    warn: (msg: string) => loggedWarnings.push(msg),
    error: () => undefined,
  },
}));

import express from "express";
import adminRouter from "../routes/admin.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return app;
}

beforeEach(() => {
  fsCalls.length = 0;
  usersDocs = {};
  glmOperationsDocs = [];
  authDisabledUids.length = 0;
  authRevokedUids.length = 0;
  authNextError = null;
  loggedWarnings.length = 0;
});

describe("POST /api/admin/customer/:uid/delete — 404 + 409 paths", () => {
  it("404 when the user doc doesn't exist", async () => {
    const res = await request(buildApp()).post("/api/admin/customer/missing-uid/delete");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("409 when a suspension op is already pending for this uid", async () => {
    usersDocs["uid-alice"] = { username: "alice", email: "alice@example.com" };
    glmOperationsDocs = [
      {
        id: "op-existing",
        data: {
          kind: "suspend-customer",
          status: "pending",
          inputUid: "uid-alice",
          input: { uid: "uid-alice" },
        },
      },
    ];
    const res = await request(buildApp()).post("/api/admin/customer/uid-alice/delete");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in progress/i);
    expect(res.body.operationId).toBe("op-existing");
  });

  it("409 when an erasure op is already running", async () => {
    usersDocs["uid-alice"] = { username: "alice" };
    glmOperationsDocs = [
      { id: "op-running", data: { kind: "erase-customer", status: "running", inputUid: "uid-alice", input: { uid: "uid-alice" } } },
    ];
    const res = await request(buildApp()).post("/api/admin/customer/uid-alice/delete");
    expect(res.status).toBe(409);
  });
});

describe("POST /api/admin/customer/:uid/delete — has-slug branch", () => {
  it("enqueues suspension and retained erasure operations, returning their durable ids", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      email: "alice@example.com",
      provisioning: { openclaw: { slug: "alice", gatewayId: "gw-test" } },
    };
    const res = await request(buildApp()).post("/api/admin/customer/uid-alice/delete");
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "deletion_scheduled",
      slug: "alice",
      suspensionOperationId: expect.any(String),
      erasureOperationId: expect.any(String),
    });
    const operationWrites = fsCalls.filter(
      (call) => call.collection === "glmOperations" && call.op === "batch.set",
    );
    expect(operationWrites.map((call) => call.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "suspend-customer", inputUid: "uid-alice" }),
      expect.objectContaining({ kind: "erase-customer", inputUid: "uid-alice" }),
    ]));
  });

  it("uses provisioning.openclaw.slug as canonical when username is absent", async () => {

usersDocs["uid-alice"] = {
      provisioning: { openclaw: { slug: "alice-via-onboarding" } },
    };
    const res = await request(buildApp()).post("/api/admin/customer/uid-alice/delete");
    expect(res.status).toBe(202);
    expect(res.body.slug).toBe("alice-via-onboarding");
    
    expect(authDisabledUids).toEqual(["uid-alice"]);
    expect(authRevokedUids).toEqual(["uid-alice"]);
  });

  it("does NOT delete the user doc inline when slug is present (handler does that)", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      provisioning: { openclaw: { slug: "alice" } },
    };
    await request(buildApp()).post("/api/admin/customer/uid-alice/delete");
    expect(authDisabledUids).toEqual(["uid-alice"]);
    expect(fsCalls.find((c) => c.collection === "users" && c.op === "doc.delete")).toBeUndefined();
  });
});

describe("POST /api/admin/customer/:uid/delete — no-slug lifecycle", () => {
  it("schedules retention and suspends Auth without deleting identity inline", async () => {
    usersDocs["uid-bob"] = { email: "bob@example.com" };
    const res = await request(buildApp()).post("/api/admin/customer/uid-bob/delete");
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "deletion_scheduled", slug: null });
    expect(authDisabledUids).toEqual(["uid-bob"]);
    expect(authRevokedUids).toEqual(["uid-bob"]);
    expect(fsCalls.some((c) => c.collection === "users" && c.op === "doc.delete")).toBe(false);
  });

  it("treats an already-missing Auth account as an idempotent suspension success", async () => {
    usersDocs["uid-bob"] = { email: "bob@example.com" };
    const e = Object.assign(new Error("user not found"), { code: "auth/user-not-found" });
    authNextError = e;
    const res = await request(buildApp()).post("/api/admin/customer/uid-bob/delete");
    expect(res.status).toBe(202);
    expect(fsCalls.some((c) => c.collection === "glmOperations" && c.op === "batch.set")).toBe(true);
  });

  it("does NOT swallow other auth errors (e.g. quota) just because they mention 'user-not-found'", async () => {
    usersDocs["uid-bob"] = { email: "bob@example.com" };
    const e = Object.assign(new Error("quota exceeded — user-not-found cache full"), {
      code: "auth/quota-exceeded",
    });
    authNextError = e;
    const res = await request(buildApp()).post("/api/admin/customer/uid-bob/delete");
    expect(res.status).toBe(500);
  });

  it("enqueues lifecycle operations even when provisioning never produced a slug", async () => {
    usersDocs["uid-bob"] = { email: "bob@example.com" };
    await request(buildApp()).post("/api/admin/customer/uid-bob/delete");
    expect(fsCalls.filter((c) => c.collection === "glmOperations" && c.op === "batch.set")).toHaveLength(2);
  });
});

describe("POST /api/admin/customer/:uid/delete — Stripe cleanup context", () => {
  it("persists Stripe ids for the suspension worker instead of logging a manual-cleanup warning", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      email: "alice@example.com",
      provisioning: { openclaw: { slug: "alice" } },
      subscription: {
        stripeSubscriptionId: "sub_123",
        stripeCustomerId: "cus_abc",
        status: "active",
      },
    };
    await request(buildApp()).post("/api/admin/customer/uid-alice/delete");
    const job = fsCalls.find(
      (call) => call.collection === "customerDeletionJobs" && call.op === "batch.set",
    );
    expect(job?.data).toMatchObject({
      stripeCustomerId: "cus_abc",
      stripeSubscriptionId: "sub_123",
    });
    expect(loggedWarnings).toEqual([]);
  });

  it("does NOT log when no stripe IDs are present", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      provisioning: { openclaw: { slug: "alice" } },
    };
    await request(buildApp()).post("/api/admin/customer/uid-alice/delete");
    expect(loggedWarnings.length).toBe(0);
  });
});
