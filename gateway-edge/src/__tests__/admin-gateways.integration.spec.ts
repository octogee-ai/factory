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
      lastError: null,
    },
    "gw-test-green": {
      gatewayId: "gw-test-green",
      status: "ready",
      version: "def5678",
      openclawVersion: "v1.2.3",
      mountedCustomers: ["dana"],
      lastHeartbeatAt: { toDate: () => new Date(Date.now() - 5_000) },
      lastError: null,
    },
    "gw-test-stale": {
      gatewayId: "gw-test-stale",
      status: "unreachable",
      version: "ghi9012",
      openclawVersion: "v1.2.3",
      mountedCustomers: [],
      lastHeartbeatAt: { toDate: () => new Date(Date.now() - 5 * 60_000) },
      lastError: { slug: "frodo", message: "git clone timeout", at: { toDate: () => new Date() } },
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
import adminRouter from "../routes/admin.js";

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
    });
    expect(blue.heartbeatAgeMs).toBeGreaterThanOrEqual(0);
    expect(blue.heartbeatAgeMs).toBeLessThan(5_000);
  });

  it("projects the durable gateway identity, convention-derived when no glmGateways doc carries the field yet", async () => {
    const res = await request(app).get("/api/admin/gateways");
    const blue = res.body.gateways.find((g: any) => g.gatewayId === "gw-test-blue");
    const green = res.body.gateways.find((g: any) => g.gatewayId === "gw-test-green");
    const stale = res.body.gateways.find((g: any) => g.gatewayId === "gw-test-stale");
    // Blue/green siblings share one gateway identity by convention-parse.
    expect(blue.gateway).toBe("gw-test");
    expect(green.gateway).toBe("gw-test");
    // An id without a roll-role suffix is its own bare identity.
    expect(stale.gateway).toBe("gw-test-stale");
  });

  it("rolls up gateway counts including derived unreachable, and customers mounted", async () => {
    // unreachable is derived from heartbeat age (gw-test-stale is 5m stale), not a written status.
    const res = await request(app).get("/api/admin/gateways");
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({
      gateways: { total: 3, ready: 2, unreachable: 1 },
      customersMounted: 4,
    });
  });

  it("surfaces lastError on a gateway when present", async () => {
    const res = await request(app).get("/api/admin/gateways");
    const stale = res.body.gateways.find((g: any) => g.gatewayId === "gw-test-stale");
    expect(stale.lastError).toMatchObject({
      slug: "frodo",
      message: "git clone timeout",
    });
  });
});
