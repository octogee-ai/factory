import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  addAdminCustomerRoutes,
  mergeDailyUsage,
  type AdminCustomerRouterDeps,
} from "./admin-customer-router.js";

type DocData = Record<string, unknown>;
type DocStore = Map<string, DocData>;

function docSnapshot(path: string, data: DocData | undefined) {
  return {
    id: path.split("/").pop() ?? path,
    exists: data !== undefined,
    data: () => data,
  };
}

function collectionDocs(path: string, store: DocStore) {
  const prefix = `${path}/`;
  return [...store.entries()]
    .filter(([docPath]) => {
      if (!docPath.startsWith(prefix)) return false;
      return !docPath.slice(prefix.length).includes("/");
    })
    .map(([docPath, data]) => docSnapshot(docPath, data));
}

function fakeDoc(path: string, store: DocStore) {
  return {
    get: async () => docSnapshot(path, store.get(path)),
    collection: (collectionId: string) => fakeCollection(`${path}/${collectionId}`, store),
    update: async (patch: DocData) => {
      const current = store.get(path);
      if (!current) throw new Error(`missing doc: ${path}`);
      store.set(path, { ...current, ...patch });
    },
    set: async (data: DocData) => {
      store.set(path, data);
    },
  };
}

function fakeCollection(path: string, store: DocStore) {
  const query = {
    doc: (docId = `auto-${store.size + 1}`) => fakeDoc(`${path}/${docId}`, store),
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    startAfter: () => query,
    get: async () => ({ docs: collectionDocs(path, store) }),
  };
  return query;
}

function fakeDb(docs: Record<string, DocData>): Firestore {
  const store = new Map(Object.entries(docs));
  return {
    collection: (path: string) => fakeCollection(path, store),
    doc: (path: string) => fakeDoc(path, store),
    getAll: async (...refs: Array<{ get: () => Promise<unknown> }>) =>
      Promise.all(refs.map((ref) => ref.get())),
  } as unknown as Firestore;
}

function makeApp(docs: Record<string, DocData>) {
  const app = express();
  app.use(express.json());

  const deps: AdminCustomerRouterDeps = {
    db: fakeDb(docs),
    FieldValue: { serverTimestamp: () => new Date("2026-06-01T00:00:00.000Z") },
    logger: { info: vi.fn(), warn: vi.fn() },
    workspaceSlugsForUser: () => [],
    getWorkspaceMmContext: vi.fn().mockResolvedValue(null),
  };

  const router = express.Router();
  addAdminCustomerRoutes(router, deps);
  app.use("/api/admin", router);
  return app;
}

function customerDoc(overrides: DocData = {}): DocData {
  return {
    email: "builder@example.com",
    username: "builder",
    displayName: "Builder",
    subscription: { tier: "hobby", status: "active" },
    usage: {},
    provisioning: { openclaw: { status: "complete", slug: "builder" } },
    ...overrides,
  };
}

describe("GET /api/admin/customer/:uid — model credential state", () => {
  it("returns sanitized modelCredential metadata and keeps byot as an active compatibility alias", async () => {
    const app = makeApp({
      "users/uid-1": customerDoc({ byotActive: false }),
      "users/uid-1/system/config": {
        modelCredential: {
          active: true,
          provider: "anthropic",
          mode: "api_key",
          status: "active",
          reasonCode: "ok",
          secretName: "byok-secret-anthropic",
          keyHash: "deadbeefcafe",
          fingerprint: "sk-ant...7890",
          model: "claude-sonnet-4-6",
          lastUsedAt: new Date("2026-06-02T03:04:05.000Z"),
        },
      },
    });

    const res = await request(app).get("/api/admin/customer/uid-1").expect(200);

    expect(res.body.modelCredential).toEqual({
      active: true,
      provider: "anthropic",
      mode: "api_key",
      status: "active",
      reasonCode: "ok",
      fingerprint: "sk-ant...7890",
      model: "claude-sonnet-4-6",
      baseUrl: null,
      lastUsedAt: "2026-06-02T03:04:05.000Z",
    });
    expect(res.body.byot).toEqual({ active: true });
    expect(JSON.stringify(res.body.modelCredential)).not.toContain("byok-secret-anthropic");
    expect(JSON.stringify(res.body.modelCredential)).not.toContain("deadbeefcafe");
  });

  it("keeps legacy byot.active when no modelCredential has been written yet", async () => {
    const app = makeApp({
      "users/uid-legacy": customerDoc({ byotActive: true }),
    });

    const res = await request(app).get("/api/admin/customer/uid-legacy").expect(200);

    expect(res.body.modelCredential).toBeNull();
    expect(res.body.byot).toEqual({ active: true });
  });

});

describe("mergeDailyUsage", () => {
  it("keeps legacy token/interaction telemetry but takes USD only from the broker series", () => {
    const merged = mergeDailyUsage(
      [
        { date: "2026-06-30", tokensUsed: 469_438, interactions: 19, costUsd: 0 },
        { date: "2026-06-29", tokensUsed: 676_435, interactions: 23, costUsd: 0.0001 },
      ],
      new Map([
        ["2026-06-30", { date: "2026-06-30", costUsd: 0.72, totalTokens: 420_000, requestCount: 15 }],
      ]),
    );

    expect(merged[0]).toMatchObject({
      date: "2026-06-30",
      tokensUsed: 469_438, // legacy telemetry survives (covers byosub traffic)
      interactions: 19,
      costUsd: 0.72, // broker is the only USD source
      brokerTokens: 420_000,
    });
    // no broker events that day → $0, never the legacy openclaw figure
    expect(merged[1]).toMatchObject({ date: "2026-06-29", costUsd: 0 });
  });

  it("surfaces broker-only days that have no legacy log doc", () => {
    const merged = mergeDailyUsage(
      [],
      new Map([
        ["2026-07-01", { date: "2026-07-01", costUsd: 0.29, totalTokens: 90_000, requestCount: 4 }],
      ]),
    );
    expect(merged).toEqual([
      {
        date: "2026-07-01",
        tokensUsed: 90_000,
        interactions: 4,
        costUsd: 0.29,
        brokerTokens: 90_000,
      },
    ]);
  });
});

describe("GET /api/admin/customer/:uid — broker-sourced usage", () => {
  it("serves USD from the broker ledger and never the legacy $0 fields", async () => {
    const app = makeApp({
      "users/uid-1": customerDoc({
        usage: { costUsd: 0.0001, totalTokensUsed: 1_145_873, windowTokensUsed: 469_438 },
      }),
      "modelBrokerUsageRollups/uid-1": {
        costUsd: 1.73,
        totalTokens: 1_323_462,
        models: {
          "claude-sonnet-4-6": { model: "claude-sonnet-4-6", totalTokens: 738_246, costUsd: 1.0462 },
        },
      },
    });

    const res = await request(app).get("/api/admin/customer/uid-1").expect(200);
    expect(res.body.usage).toMatchObject({
      costUsd: 1.73,
      brokerTotalTokens: 1_323_462,
      totalTokensUsed: 1_145_873,
    });
    expect(res.body.usage).not.toHaveProperty("windowTokensUsed");
    expect(res.body.usage).not.toHaveProperty("windowSize");
    expect(res.body.summary.costUsd).toBe(1.73);
    expect(res.body.modelCosts["claude-sonnet-4-6"]).toMatchObject({
      tokens: 738_246,
      costUsd: 1.0462,
    });
  });
});

describe("POST /api/admin/customer/:uid/ops", () => {
  it("rejects setThrottle — the in-pod throttle was retired (#1880)", async () => {
    const app = makeApp({
      "users/uid-ops": customerDoc({}),
    });

    const res = await request(app)
      .post("/api/admin/customer/uid-ops/ops")
      .send({ action: "setThrottle", value: false })
      .expect(400);

    expect(res.body.error).toMatch(/unknown ops action/i);
  });
});
