import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpServer, type HttpServerDeps } from "../http-server";

interface FakeStore {
  users: Record<string, Record<string, unknown>>;
  configs: Record<string, { role?: string }>;
  gateways: Record<string, Record<string, unknown>>;
  glmGateways: Record<string, Record<string, unknown>>;
  glmOperations: Array<{ id: string; data: Record<string, unknown> }>;
  restoreJobs: Array<{ id: string; data: Record<string, unknown> }>;
}

function emptyStore(): FakeStore {
  return {
    users: {},
    configs: {},
    gateways: {},
    glmGateways: {},
    glmOperations: [],
    restoreJobs: [],
  };
}

function makeQuery(
  collectionName: string,
  store: FakeStore,
  filters: Array<{ field: string; value: unknown }> = [],
) {
  const matches = (data: Record<string, unknown>): boolean =>
    filters.every((f) => {
      const v = data[f.field];
      if (Array.isArray(f.value))
        return (f.value as unknown[]).includes(v);
      return v === f.value;
    });
  return {
    where: (field: string, _op: string, value: unknown) =>
      makeQuery(collectionName, store, [...filters, { field, value }]),
    orderBy: () => makeQuery(collectionName, store, filters),
    limit: () => makeQuery(collectionName, store, filters),
    get: async () => {
      if (collectionName === "gateways") {
        const docs = Object.entries(store.gateways)
          .filter(([, d]) => matches(d))
          .map(([id, data]) => ({ id, data: () => data }));
        return { docs, size: docs.length };
      }
      if (collectionName === "restoreJobs") {
        const docs = store.restoreJobs
          .filter((j) => matches(j.data))
          .map((j) => ({ id: j.id, data: () => j.data }));
        return { docs, size: docs.length };
      }
      if (collectionName === "users") {
        const docs = Object.entries(store.users)
          .filter(([, d]) => matches(d))
          .map(([id, data]) => ({ id, data: () => data }));
        return { docs, size: docs.length };
      }
      if (collectionName === "glmOperations") {
        const docs = store.glmOperations
          .filter((o) => matches(o.data))
          .map((o) => ({ id: o.id, data: () => o.data }));
        return { docs, size: docs.length };
      }
      if (collectionName === "glmGateways") {
        const docs = Object.entries(store.glmGateways)
          .filter(([, d]) => matches(d))
          .map(([id, data]) => ({ id, data: () => data }));
        return { docs, size: docs.length };
      }
      return { docs: [], size: 0 };
    },
  };
}

function buildDb(store: FakeStore) {
  return {
    // Bare-bones transaction stub: real Firestore replays on contention,
    // here we just route txn.get/update to the underlying ref methods.
    // Sufficient for verifying the read-before-write order + the
    // intended writes; doesn't exercise contention/retry semantics.
    runTransaction: async <T,>(
      fn: (txn: {
        get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
        update: (
          ref: { update: (patch: Record<string, unknown>) => Promise<void> },
          patch: Record<string, unknown>,
        ) => void;
      }) => Promise<T>,
    ): Promise<T> => {
      const queued: Array<() => Promise<void>> = [];
      const txn = {
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        update: (
          ref: { update: (patch: Record<string, unknown>) => Promise<void> },
          patch: Record<string, unknown>,
        ) => {
          // Buffer writes till the callback completes — mirrors real
          // Firestore semantics where writes commit atomically at the
          // end of the txn callback.
          queued.push(() => ref.update(patch));
        },
      };
      const result = await fn(txn);
      for (const w of queued) await w();
      return result;
    },
    collection: (name: string): unknown => ({
      doc: (id: string) => ({
        id,
        get: async () => {
          if (name === "users") {
            const data = store.users[id];
            return { exists: data !== undefined, data: () => data };
          }
          if (name === "gateways") {
            const data = store.gateways[id];
            return { exists: data !== undefined, data: () => data };
          }
          if (name === "glmGateways") {
            const data = store.glmGateways[id];
            return { exists: data !== undefined, data: () => data };
          }
          if (name === "restoreJobs") {
            const job = store.restoreJobs.find((j) => j.id === id);
            return { exists: job !== undefined, data: () => job?.data };
          }
          return { exists: false, data: () => undefined };
        },
        update: async (patch: Record<string, unknown>) => {
          if (name === "gateways" && store.gateways[id]) {
            store.gateways[id] = { ...store.gateways[id], ...patch };
            return;
          }
          if (name === "restoreJobs") {
            const job = store.restoreJobs.find((j) => j.id === id);
            if (job) job.data = { ...job.data, ...patch };
            return;
          }
          if (name === "glmGateways" && store.glmGateways[id]) {
            store.glmGateways[id] = { ...store.glmGateways[id], ...patch };
            return;
          }
        },
        collection: (sub: string) => ({
          doc: (subId: string) => ({
            get: async () => {
              if (
                name === "users" &&
                sub === "system" &&
                subId === "config"
              ) {
                const data = store.configs[id];
                return { exists: data !== undefined, data: () => data };
              }
              return { exists: false, data: () => undefined };
            },
          }),
        }),
      }),
      where: (field: string, _op: string, value: unknown) =>
        makeQuery(name, store, [{ field, value }]),
      orderBy: () => makeQuery(name, store),
      limit: () => makeQuery(name, store),
      get: async () => {
        if (name === "gateways") {
          const docs = Object.entries(store.gateways).map(([id, data]) => ({
            id,
            data: () => data,
          }));
          return { docs, size: docs.length };
        }
        if (name === "restoreJobs") {
          const docs = store.restoreJobs.map((j) => ({
            id: j.id,
            data: () => j.data,
          }));
          return { docs, size: docs.length };
        }
        if (name === "users") {
          const docs = Object.entries(store.users).map(([id, data]) => ({
            id,
            data: () => data,
          }));
          return { docs, size: docs.length };
        }
        return { docs: [], size: 0 };
      },
    }),
  };
}

function buildDeps(store: FakeStore): HttpServerDeps {
  return {
    db: buildDb(store) as any,
    log: vi.fn(),
    verifyIdToken: vi.fn(async (token: string) => {
      if (token === "admin-token") return { uid: "admin-uid" };
      if (token === "user-token") return { uid: "user-uid" };
      throw new Error("invalid token");
    }),
    workspaceSlugsForUser: (data) => {
      const slug =
        typeof data?.username === "string" && data.username.length > 0
          ? data.username
          : null;
      return slug ? [slug] : [];
    },
    provisionGatewayAuthSecret: vi.fn(async () => ({
      secretName: "stub",
      created: true,
    })),
    listGatewayBuilds: vi.fn(async () => []),
    deleteAuthUserTolerantOfMissing: vi.fn(async () => undefined),
  };
}

describe("createHttpServer — admin gateway routes", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = emptyStore();
    store.users["admin-uid"] = { email: "admin@octogee.com" };
    store.configs["admin-uid"] = { role: "admin" };
    store.users["user-uid"] = { email: "user@octogee.com" };
    store.configs["user-uid"] = { role: "operator" };
  });

  it("/healthz responds without auth", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: "glm-controller" });
  });

  it("sets CORS headers for allowed origins (admin UI fetches from app[-test].web.app)", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/healthz")
      .set("Origin", "https://app-octogee-test.web.app");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app-octogee-test.web.app");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["vary"]).toContain("Origin");
  });

  it("answers OPTIONS preflight with 204 + CORS headers (no auth needed)", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .options("/api/admin/customers")
      .set("Origin", "https://app-octogee-test.web.app")
      .set("Access-Control-Request-Method", "GET");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app-octogee-test.web.app");
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
  });

  it("does not set CORS headers for disallowed origins", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/healthz")
      .set("Origin", "https://evil.example.com");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app).get("/api/admin/gateways");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin tokens with 403", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer user-token");
    expect(res.status).toBe(403);
  });

  it("serves /api/admin/gateways for admins (empty fleet)", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");
    expect(res.status).toBe(200);
    expect(res.body.gateways).toEqual([]);
    expect(res.body.stats.gateways).toEqual({
      total: 0,
      ready: 0,
      unreachable: 0,
    });
  });

  it("serves /api/admin/gateways with populated fleet stats", async () => {
    store.gateways["gw-blue"] = {
      gatewayId: "gw-blue",
      status: "ready",
      version: "abc1234",
      mountedCustomers: ["alice", "bob"],
      lastHeartbeatAt: Date.now() - 2_000,
    };
    store.gateways["gw-stale"] = {
      gatewayId: "gw-stale",
      status: "unreachable",
      version: "def5678",
      mountedCustomers: [],
      lastHeartbeatAt: Date.now() - 5 * 60_000,
    };
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/gateways")
      .set("Authorization", "Bearer admin-token");
    expect(res.status).toBe(200);
    expect(res.body.gateways).toHaveLength(2);
    expect(res.body.stats.gateways).toEqual({
      total: 2,
      ready: 1,
      unreachable: 1,
    });
    expect(res.body.stats.customersMounted).toBe(2);
  });

  it("serves /api/admin/operations as paginated list", async () => {
    store.glmOperations.push({
      id: "op-1",
      data: {
        kind: "add-gateway",
        status: "succeeded",
        createdAt: 100,
        input: { gatewayId: "gw-blue" },
      },
    });
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/operations")
      .set("Authorization", "Bearer admin-token");
    expect(res.status).toBe(200);
    expect(res.body.operations).toHaveLength(1);
    expect(res.body.operations[0]).toMatchObject({
      id: "op-1",
      kind: "add-gateway",
      status: "succeeded",
    });
  });

  // Customer-detail factory mount (PR #865 lift). The compute-heavy
  // CSI pipeline lives in gateway-edge so glm-controller's stub
  // returns 503 with a friendly reason instead of pretending to
  // refresh. The customer-list / customer-detail GETs are exercised
  // by the gateway-edge integration suite (admin-csi.integration);
  // we just verify the route is mounted here so a missing factory
  // wire-up shows up as a deterministic test failure.

  it("mounts addAdminCustomerRoutes and returns 404 for unknown customer (factory wired)", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .get("/api/admin/customer/does-not-exist")
      .set("Authorization", "Bearer admin-token");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "User not found" });
  });

  it("/api/admin/customer/:uid/csi-refresh returns 503 with friendly unavailable reason", async () => {
    const app = createHttpServer(buildDeps(store));
    const res = await request(app)
      .post("/api/admin/customer/admin-uid/csi-refresh")
      .set("Authorization", "Bearer admin-token");
    expect(res.status).toBe(503);
    expect(res.body.unavailable).toBe(true);
    expect(res.body.success).toBe(false);
    expect(res.body.reason).toMatch(/csi.*gateway-edge|gateway pod/i);
  });

  describe("POST /api/admin/restore-jobs/:jobId/kick — unstick a stuck customer", () => {
    function seedStuckJob() {
      store.gateways["gw-test"] = {
        gatewayId: "gw-test",
        status: "ready",
        inFlightJobId: "job-stuck",
        mountedCustomers: [],
      };
      store.restoreJobs = [
        {
          id: "job-stuck",
          data: {
            jobId: "job-stuck",
            gatewayId: "gw-test",
            state: "dispatched",
            attempt: 1,
            createdAt: { toMillis: () => 1_000 },
            dispatchedAt: { toMillis: () => 1_500 },
            completedAt: null,
            error: null,
            snapshot: { uid: "u-basim", slug: "basim" },
          },
        },
      ];
    }

    it("returns 401 without auth", async () => {
      seedStuckJob();
      const app = createHttpServer(buildDeps(store));
      const res = await request(app).post("/api/admin/restore-jobs/job-stuck/kick");
      expect(res.status).toBe(401);
    });

    it("returns 403 for non-admin", async () => {
      seedStuckJob();
      const app = createHttpServer(buildDeps(store));
      const res = await request(app)
        .post("/api/admin/restore-jobs/job-stuck/kick")
        .set("Authorization", "Bearer user-token");
      expect(res.status).toBe(403);
    });

    it("returns 404 when the job doesn't exist", async () => {
      const app = createHttpServer(buildDeps(store));
      const res = await request(app)
        .post("/api/admin/restore-jobs/no-such-job/kick")
        .set("Authorization", "Bearer admin-token");
      expect(res.status).toBe(404);
    });

    it("happy path: marks the job failed (operator-kicked) + clears inFlightJobId on the gateway", async () => {
      seedStuckJob();
      const app = createHttpServer(buildDeps(store));
      const res = await request(app)
        .post("/api/admin/restore-jobs/job-stuck/kick")
        .set("Authorization", "Bearer admin-token");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        jobId: "job-stuck",
        gatewayId: "gw-test",
        slug: "basim",
      });

      // Job is now failed with operator-kicked error.
      const job = store.restoreJobs.find((j) => j.id === "job-stuck");
      expect(job?.data.state).toBe("failed");
      expect(job?.data.error).toMatch(/operator-kicked/);

      // Gateway's inFlightJobId is cleared so the next reconcile tick
      // can claim a new job for the same customer.
      expect(store.gateways["gw-test"].inFlightJobId).toBeNull();
    });

    it("refuses to kick a job that's already in a terminal state (idempotent / safe)", async () => {
      seedStuckJob();
      // Pre-complete the job — operator may have raced with the gateway's ack.
      const job = store.restoreJobs.find((j) => j.id === "job-stuck")!;
      job.data.state = "done";
      job.data.completedAt = { toMillis: () => 2_500 };
      const app = createHttpServer(buildDeps(store));
      const res = await request(app)
        .post("/api/admin/restore-jobs/job-stuck/kick")
        .set("Authorization", "Bearer admin-token");
      expect(res.status).toBe(409);
      // Error message uses the new allowlist phrasing — `done` isn't in
      // {pending, dispatched, running} so it's not kickable.
      expect(res.body.error).toMatch(/not kickable|allowed/i);
      expect(res.body.state).toBe("done");
    });

    it("preserves inFlightJobId when it points at a different (newer) job — only clears when it matches the kicked job", async () => {
      // Operator hits kick on jobA, but the gateway doc still has jobB.
      // We mark jobA failed for the audit trail; we MUST NOT clear the
      // gateway's lock since that would stomp the fresh assignment.
      seedStuckJob();
      store.gateways["gw-test"].inFlightJobId = "different-job";
      const app = createHttpServer(buildDeps(store));
      const res = await request(app)
        .post("/api/admin/restore-jobs/job-stuck/kick")
        .set("Authorization", "Bearer admin-token");
      expect(res.status).toBe(200);
      const job = store.restoreJobs.find((j) => j.id === "job-stuck");
      expect(job?.data.state).toBe("failed");
      // Lock NOT cleared — it points at a different (presumably newer) job.
      expect(store.gateways["gw-test"].inFlightJobId).toBe("different-job");
    });

    it("rejects (409) when the job state isn't in the kickable allowlist (defense against unknown future states)", async () => {
      seedStuckJob();
      // Hypothetical future state we don't explicitly permit.
      const job = store.restoreJobs.find((j) => j.id === "job-stuck")!;
      job.data.state = "migrating";
      const app = createHttpServer(buildDeps(store));
      const res = await request(app)
        .post("/api/admin/restore-jobs/job-stuck/kick")
        .set("Authorization", "Bearer admin-token");
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/not kickable|allowed/i);
      // State should be unchanged — we refused to write.
      expect(job.data.state).toBe("migrating");
    });
  });
});
