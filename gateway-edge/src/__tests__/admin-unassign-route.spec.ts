import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Pins the atomic unassign the PR9 bulk-unassign fan-out depends on
// (admin-fleet-router POST /customers/:uid/unassign). In ONE transaction it
// deletes gateways/{gw}/assignments/{uid} AND clears the user mirror, and the
// guard runs INSIDE that transaction: it refuses (409) if a migrate op is
// pending/running OR the durable assignment state is not "serving" — so a
// terminal failed roll that left the customer quiescing cannot be silently
// unassigned. Never deletes the user or their workspace.

interface StoredDoc {
  [k: string]: unknown;
}

const state: {
  store: Record<string, StoredDoc | undefined>;
} = { store: {} };

vi.mock("@octogee/core/platform-state", async (importOriginal) => {
  const { createJournalFixtureStore, fixtureDocumentsAt } = await import("@octogee/core/testing/journal-store");
  const documents = () => fixtureDocumentsAt(state.store);
  return {
    ...(await importOriginal<typeof import("@octogee/core/platform-state")>()),
    createFirestorePlatformStateStore: () => createJournalFixtureStore(
      {
        get: (id) => state.store[`glmOperations/${id}`],
        set: (id, row) => {
          state.store[`glmOperations/${id}`] = row;
        },
      },
      {
        documents: {
          get: (path) => documents().get(path),
          set: (path, row) => documents().set(path, row),
          delete: (path) => documents().delete(path),
          children: (collectionPath) => documents().children(collectionPath),
          group: (collectionId) => documents().group(collectionId),
        },
      },
    ),
  };
});

vi.mock("../lib/db", () => {
  function docRef(path: string): any {
    return {
      __path: path,
      get: async () => ({ exists: state.store[path] !== undefined, data: () => state.store[path] }),
      update: async (data: StoredDoc) => {
        state.store[path] = { ...(state.store[path] ?? {}), ...data };
      },
      set: async (data: StoredDoc) => {
        state.store[path] = data;
      },
      delete: async () => {
        delete state.store[path];
      },
      collection: (name: string) => ({ doc: (id: string) => docRef(`${path}/${name}/${id}`) }),
    };
  }

  type QueryFilter = { field: string; op: string; value: unknown };

  function runQuery(collectionName: string, filters: QueryFilter[]) {
    const docs = Object.entries(state.store)
      .filter(([path, data]) => {
        const parts = path.split("/");
        if (parts.length !== 2 || parts[0] !== collectionName || data === undefined) return false;
        return filters.every((f) => {
          const actual = (data as StoredDoc)[f.field];
          return f.op === "in" ? (f.value as unknown[]).includes(actual) : actual === f.value;
        });
      })
      .map(([path, data]) => ({ id: path.split("/")[1], data: () => data }));
    return { docs, size: docs.length };
  }

  function queryRef(collectionName: string, filters: QueryFilter[]): any {
    return {
      __query: { collectionName, filters },
      where: (field: string, op: string, value: unknown) =>
        queryRef(collectionName, [...filters, { field, op, value }]),
      get: async () => runQuery(collectionName, filters),
    };
  }

  function collection(name: string): any {
    return {
      doc: (id: string) => docRef(`${name}/${id}`),
      where: (field: string, op: string, value: unknown) =>
        queryRef(name, [{ field, op, value }]),
    };
  }

  const db = {
    collection,
    doc: (path: string) => docRef(path),
    runTransaction: async <T>(body: (txn: any) => Promise<T>): Promise<T> => {
      const pending: Array<() => void> = [];
      const txn = {
        get: async (refOrQuery: any) => {
          if (refOrQuery.__query) {
            return runQuery(refOrQuery.__query.collectionName, refOrQuery.__query.filters);
          }
          return {
            exists: state.store[refOrQuery.__path] !== undefined,
            data: () => state.store[refOrQuery.__path],
          };
        },
        update: (ref: any, data: StoredDoc) =>
          pending.push(() => {
            state.store[ref.__path] = { ...(state.store[ref.__path] ?? {}), ...data };
          }),
        create: (ref: any, data: StoredDoc) =>
          pending.push(() => {
            state.store[ref.__path] = data;
          }),
        set: (ref: any, data: StoredDoc) =>
          pending.push(() => {
            state.store[ref.__path] = { ...data };
          }),
        delete: (ref: any) => pending.push(() => { delete state.store[ref.__path]; }),
      };
      const result = await body(txn);
      for (const w of pending) w();
      return result;
    },
    getAll: async () => [],
  };

  return {
    db,
    FieldValue: { serverTimestamp: () => "now", delete: () => ({ __delete: true }) },
    Timestamp: { now: () => ({ toDate: () => new Date() }) },
    ADMIN_UID: "admin-user",
  };
});

vi.mock("../middleware/auth", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.user = { uid: "admin-user" };
    req.uid = "admin-user";
    next();
  },
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { uid: "admin-user" };
    req.uid = "admin-user";
    next();
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

function seedMountedUser(uid: string, gatewayId: string) {
  state.store[`users/${uid}`] = {
    provisioning: { openclaw: { gatewayId, gatewayProfile: "standard", controlUiEnabled: true } },
  };
}

function seedAssignment(gatewayId: string, uid: string, over: Partial<StoredDoc> = {}) {
  state.store[`gateways/${gatewayId}/assignments/${uid}`] = {
    uid,
    slug: uid,
    gatewayId,
    revisionId: `${gatewayId}-r1`,
    release: 1,
    source: "onboarding",
    state: "serving",
    epoch: 1,
    updatedAt: 1,
    updatedByOperationId: null,
    ...over,
  };
}

describe("POST /api/admin/users/:uid/unassign", () => {
  let app: express.Express;

  beforeEach(() => {
    state.store = {};
    app = buildApp();
  });

  it("clears the placement AND deletes the assignment doc in one transaction", async () => {
    seedMountedUser("u-serving", "gw-blue");
    seedAssignment("gw-blue", "u-serving");

    const res = await request(app).post("/api/admin/users/u-serving/unassign");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unassigned: true, uid: "u-serving", from: "gw-blue" });
    // Assignment doc gone (P1-2): the durable roster is no longer contaminated.
    expect(state.store["gateways/gw-blue/assignments/u-serving"]).toBeUndefined();
    expect(state.store["users/u-serving"]).toEqual({ provisioning: { openclaw: {} } });
  });

  it("is NOT destructive — never deletes the user doc", async () => {
    seedMountedUser("u-serving", "gw-blue");
    await request(app).post("/api/admin/users/u-serving/unassign");
    expect(state.store["users/u-serving"]).toBeDefined();
  });

  it("refuses a customer with a running migrate op (409) and writes nothing", async () => {
    seedMountedUser("u-moving", "gw-blue");
    seedAssignment("gw-blue", "u-moving");
    state.store["glmOperations/op-1"] = {
      inputUid: "u-moving",
      kind: "migrate-customer",
      status: "running",
    };

    const res = await request(app).post("/api/admin/users/u-moving/unassign");

    expect(res.status).toBe(409);
    expect(res.body.operationId).toBe("op-1");
    // No partial write: assignment intact.
    expect(state.store["gateways/gw-blue/assignments/u-moving"]).toBeDefined();
  });

  it("refuses a DURABLE quiescing assignment even with no live op (409 + state)", async () => {
    seedMountedUser("u-quiesce", "gw-blue");
    seedAssignment("gw-blue", "u-quiesce", { state: "quiescing" });

    const res = await request(app).post("/api/admin/users/u-quiesce/unassign");

    expect(res.status).toBe(409);
    expect(res.body.state).toBe("quiescing");
    expect(state.store["gateways/gw-blue/assignments/u-quiesce"]).toBeDefined();
  });

  it("refuses a durable migrating assignment (409)", async () => {
    seedMountedUser("u-mig", "gw-blue");
    seedAssignment("gw-blue", "u-mig", { state: "migrating" });

    const res = await request(app).post("/api/admin/users/u-mig/unassign");
    expect(res.status).toBe(409);
    expect(res.body.state).toBe("migrating");
  });

  it("clears a serving customer that has no assignment doc (legacy) without erroring", async () => {
    seedMountedUser("u-legacy", "gw-blue");
    const res = await request(app).post("/api/admin/users/u-legacy/unassign");
    expect(res.status).toBe(200);
  });

  it("returns 409 when the customer is already unassigned", async () => {
    state.store["users/u-none"] = { provisioning: { openclaw: {} } };
    const res = await request(app).post("/api/admin/users/u-none/unassign");
    expect(res.status).toBe(409);
  });

  it("returns 404 when the customer does not exist", async () => {
    const res = await request(app).post("/api/admin/users/ghost/unassign");
    expect(res.status).toBe(404);
  });
});
