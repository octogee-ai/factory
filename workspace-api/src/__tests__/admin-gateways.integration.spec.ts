import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db", () => {
  const ADMIN_UID = "admin-user";

  const users: Record<string, any> = {
    "admin-user": {
      provisioning: {},
    },
  };

  const gateways: Record<string, any> = {
    "gw-test-blue": {
      gatewayId: "gw-test-blue",
      status: "ready",
      version: "abc1234",
      openclawVersion: "v1.2.3",
      mountedCustomers: ["alice", "bob", "christopher"],
      lastHeartbeatAt: { toDate: () => new Date(Date.now() - 2_000) },
      inFlightJobId: null,
      lastError: null,
    },
    "gw-test-green": {
      gatewayId: "gw-test-green",
      status: "ready",
      version: "def5678",
      openclawVersion: "v1.2.3",
      mountedCustomers: ["dana"],
      lastHeartbeatAt: { toDate: () => new Date(Date.now() - 5_000) },
      inFlightJobId: "job-running",
      lastError: null,
    },
    "gw-test-stale": {
      gatewayId: "gw-test-stale",
      status: "unreachable",
      version: "ghi9012",
      openclawVersion: "v1.2.3",
      mountedCustomers: [],
      lastHeartbeatAt: { toDate: () => new Date(Date.now() - 5 * 60_000) },
      inFlightJobId: null,
      lastError: { jobId: "j1", slug: "frodo", message: "git clone timeout", at: { toDate: () => new Date() } },
    },
  };

  const now = Date.now();
  const restoreJobs: Record<string, any> = {
    "job-running": {
      jobId: "job-running",
      gatewayId: "gw-test-green",
      slug: "dana",
      state: "running",
      attempt: 1,
      createdAt: { toDate: () => new Date(now - 30_000) },
      dispatchedAt: { toDate: () => new Date(now - 25_000) },
      completedAt: null,
      error: null,
    },
    "job-stale": {
      jobId: "job-stale",
      gatewayId: "gw-test-blue",
      slug: "stuck",
      state: "dispatched",
      attempt: 1,
      createdAt: { toDate: () => new Date(now - 15 * 60_000) },
      dispatchedAt: { toDate: () => new Date(now - 14 * 60_000) },
      completedAt: null,
      error: null,
    },
    "job-pending": {
      jobId: "job-pending",
      gatewayId: "gw-test-blue",
      slug: "queued",
      state: "pending",
      attempt: 1,
      createdAt: { toDate: () => new Date(now - 5_000) },
      dispatchedAt: null,
      completedAt: null,
      error: null,
    },
    "job-done": {
      jobId: "job-done",
      gatewayId: "gw-test-blue",
      slug: "alice",
      state: "done",
      attempt: 1,
      createdAt: { toDate: () => new Date(now - 60_000) },
      dispatchedAt: { toDate: () => new Date(now - 55_000) },
      completedAt: { toDate: () => new Date(now - 50_000) },
      error: null,
    },
  };

  function makeQuery(docs: Array<{ id: string; data: () => any }>) {
    return {
      orderBy: () => makeQuery(docs),
      where: () => makeQuery(docs),
      limit: () => makeQuery(docs),
      get: async () => ({ docs, size: docs.length }),
    };
  }

  function collection(path: string): any {
    if (path === "users") {
      return {
        doc: (uid: string) => ({
          id: uid,
          get: async () => ({ exists: !!users[uid], data: () => users[uid] }),
          collection: () => ({
            doc: () => ({
              get: async () => ({ exists: false, data: () => undefined }),
            }),
          }),
        }),
      };
    }
    if (path === "gateways") {
      const docs = Object.keys(gateways).map((id) => ({ id, data: () => gateways[id] }));
      return makeQuery(docs);
    }
    if (path === "restoreJobs") {
      const docs = Object.keys(restoreJobs).map((id) => ({ id, data: () => restoreJobs[id] }));
      return makeQuery(docs);
    }
    return makeQuery([]);
  }

  return {
    db: {
      collection,
      doc: (_path: string) => ({
        get: async () => ({ exists: false, data: () => undefined }),
      }),
      getAll: async () => [],
    },
    FieldValue: { serverTimestamp: () => "now" },
    Timestamp: { now: () => ({ toDate: () => new Date() }) },
    ADMIN_UID,
  };
});

vi.mock("../middleware/auth", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.user = { uid: "admin-user" };
    next();
  },
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { uid: "admin-user" };
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

describe("GET /api/admin/gateways", () => {
  let app: express.Express;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns the fleet list with image SHA, status, mounted customers, and heartbeat freshness", async () => {
    const res = await request(app).get("/api/admin/gateways");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.gateways)).toBe(true);
    expect(res.body.gateways).toHaveLength(3);

    const blue = res.body.gateways.find((g: any) => g.gatewayId === "gw-test-blue");
    expect(blue).toMatchObject({
      gatewayId: "gw-test-blue",
      status: "ready",
      imageTag: "abc1234",
      mountedCustomers: ["alice", "bob", "christopher"],
      inFlightJobId: null,
    });
    expect(blue.heartbeatAgeMs).toBeGreaterThanOrEqual(0);
    expect(blue.heartbeatAgeMs).toBeLessThan(5_000);
  });

  it("derives in-flight job stats from restoreJobs (mounting count, stale > 10m, pending)", async () => {
    const res = await request(app).get("/api/admin/gateways");
    expect(res.status).toBe(200);
    const stats = res.body.stats;
    expect(stats).toMatchObject({
      gateways: { total: 3, ready: 2, unreachable: 1 },
      customersMounted: 4,
      inFlight: { mounting: 1, total: 1 },
      pendingPlacements: 1,
      staleJobs: 1,
    });
  });

  it("attaches in-flight job snapshot to the owning gateway", async () => {
    const res = await request(app).get("/api/admin/gateways");
    const green = res.body.gateways.find((g: any) => g.gatewayId === "gw-test-green");
    expect(green.inFlightJob).toMatchObject({
      jobId: "job-running",
      slug: "dana",
      state: "running",
    });
    expect(green.inFlightJob.ageMs).toBeGreaterThanOrEqual(0);
  });

  it("surfaces lastError on a gateway when present", async () => {
    const res = await request(app).get("/api/admin/gateways");
    const stale = res.body.gateways.find((g: any) => g.gatewayId === "gw-test-stale");
    expect(stale.lastError).toMatchObject({
      jobId: "j1",
      slug: "frodo",
      message: "git clone timeout",
    });
  });
});
