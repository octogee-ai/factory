import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FsCall {
  collection: string;
  op: "add" | "doc.delete" | "doc.update";
  docId?: string;
  data?: Record<string, unknown>;
}

const fsCalls: FsCall[] = [];
let usersDocs: Record<string, Record<string, unknown>> = {};
let glmOperationsDocs: Array<{ id: string; data: Record<string, unknown> }> = [];
const authDeletedUids: string[] = [];
let authNextError: Error | null = null;
const loggedWarnings: string[] = [];

vi.mock("../lib/db", () => {
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
      doc: (docId: string) => ({
        id: docId,
        get: async () => {
          if (name === "users") {
            const data = usersDocs[docId];
            return { exists: data !== undefined, data: () => data };
          }
          return { exists: false, data: () => undefined };
        },
        delete: async () => {
          fsCalls.push({ collection: name, op: "doc.delete", docId });
          if (name === "users") delete usersDocs[docId];
        },
        update: async (data: Record<string, unknown>) => {
          fsCalls.push({ collection: name, op: "doc.update", docId, data });
        },
      }),
      where: (field: string, op: string, value: unknown) =>
        whereChain(name, [{ field, value }]),
      orderBy: () => whereChain(name),
      limit: () => whereChain(name),
      get: async () => ({ docs: [], size: 0 }),
    };
  }

  return {
    db: { collection, doc: () => ({}), getAll: async () => [] },
    FieldValue: { serverTimestamp: () => "now" },
    Timestamp: { now: () => ({ toDate: () => new Date() }) },
  };
});

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({
    deleteUser: async (uid: string) => {
      if (authNextError) {
        const e = authNextError;
        authNextError = null;
        throw e;
      }
      authDeletedUids.push(uid);
    },
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
import adminRouter from "../routes/admin";

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
  authDeletedUids.length = 0;
  authNextError = null;
  loggedWarnings.length = 0;
});

describe("POST /api/admin/customer/:uid/delete — 404 + 409 paths", () => {
  it("404 when the user doc doesn't exist", async () => {
    const res = await request(buildApp()).post("/api/admin/customer/missing-uid/delete");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("409 when a deprovision-customer op is already pending for this uid", async () => {
    usersDocs["uid-alice"] = { username: "alice", email: "alice@example.com" };
    glmOperationsDocs = [
      {
        id: "op-existing",
        data: {
          kind: "deprovision-customer",
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

  it("409 when a deprovision-customer op is already running", async () => {
    usersDocs["uid-alice"] = { username: "alice" };
    glmOperationsDocs = [
      { id: "op-running", data: { kind: "deprovision-customer", status: "running", inputUid: "uid-alice", input: { uid: "uid-alice" } } },
    ];
    const res = await request(buildApp()).post("/api/admin/customer/uid-alice/delete");
    expect(res.status).toBe(409);
  });
});

describe("POST /api/admin/customer/:uid/delete — has-slug branch", () => {
  it("enqueues a deprovision-customer op with uid + slug, returns 202 + operationId + slug", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      email: "alice@example.com",
      provisioning: { openclaw: { slug: "alice", gatewayId: "gw-test" } },
    };
    const res = await request(buildApp()).post("/api/admin/customer/uid-alice/delete");
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "queued",
      slug: "alice",
    });
    expect(res.body.operationId).toBeTruthy();
    const opAdd = fsCalls.find((c) => c.collection === "glmOperations" && c.op === "add");
    expect(opAdd?.data).toMatchObject({
      kind: "deprovision-customer",
      status: "pending",
      createdBy: "admin-uid",
      input: { uid: "uid-alice", slug: "alice" },
      inputUid: "uid-alice",
    });
  });

  it("uses provisioning.openclaw.slug as canonical when username is absent", async () => {
    // Customers created via the app's onboarding flow can have a slug
    // only at provisioning.openclaw.slug (no username yet). Routing
    // those through the inline lite-delete branch would leak Gitea/MM
    // resources. (Copilot review)
    usersDocs["uid-alice"] = {
      provisioning: { openclaw: { slug: "alice-via-onboarding" } },
    };
    const res = await request(buildApp()).post("/api/admin/customer/uid-alice/delete");
    expect(res.status).toBe(202);
    expect(res.body.slug).toBe("alice-via-onboarding");
    // Did NOT take the inline-delete branch
    expect(authDeletedUids).toEqual([]);
  });

  it("does NOT delete the user doc inline when slug is present (handler does that)", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      provisioning: { openclaw: { slug: "alice" } },
    };
    await request(buildApp()).post("/api/admin/customer/uid-alice/delete");
    expect(authDeletedUids).toEqual([]);
    expect(fsCalls.find((c) => c.collection === "users" && c.op === "doc.delete")).toBeUndefined();
  });
});

describe("POST /api/admin/customer/:uid/delete — no-slug inline branch", () => {
  it("deletes the Auth user + user doc inline, returns 200 + deleted-inline status", async () => {
    usersDocs["uid-bob"] = { email: "bob@example.com" };
    const res = await request(buildApp()).post("/api/admin/customer/uid-bob/delete");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "deleted-inline", uid: "uid-bob" });
    expect(authDeletedUids).toEqual(["uid-bob"]);
    expect(fsCalls.some((c) => c.collection === "users" && c.op === "doc.delete" && c.docId === "uid-bob")).toBe(true);
  });

  it("swallows auth user-not-found (matches on err.code, not message substring)", async () => {
    usersDocs["uid-bob"] = { email: "bob@example.com" };
    const e = Object.assign(new Error("user not found"), { code: "auth/user-not-found" });
    authNextError = e;
    const res = await request(buildApp()).post("/api/admin/customer/uid-bob/delete");
    expect(res.status).toBe(200);
    expect(fsCalls.some((c) => c.collection === "users" && c.op === "doc.delete")).toBe(true);
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

  it("does NOT enqueue a glmOperations op for the no-slug branch", async () => {
    usersDocs["uid-bob"] = { email: "bob@example.com" };
    await request(buildApp()).post("/api/admin/customer/uid-bob/delete");
    expect(fsCalls.some((c) => c.collection === "glmOperations" && c.op === "add")).toBe(false);
  });
});

describe("POST /api/admin/customer/:uid/delete — Stripe stub", () => {
  it("logs a WARN with stripe IDs when subscription.id is set", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      email: "alice@example.com",
      provisioning: { openclaw: { slug: "alice" } },
      subscription: { id: "sub_123", status: "active" },
      stripeCustomerId: "cus_abc",
    };
    await request(buildApp()).post("/api/admin/customer/uid-alice/delete");
    expect(loggedWarnings.length).toBe(1);
    expect(loggedWarnings[0]).toMatch(/STRIPE NOT CANCELLED/);
    expect(loggedWarnings[0]).toMatch(/cus_abc/);
    expect(loggedWarnings[0]).toMatch(/sub_123/);
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
