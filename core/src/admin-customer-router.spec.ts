import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { usageWindowStartMs, weekWindowStartMs } from "@octogee/shared/types/model-broker-usage";
import {
  aggregateBrokerDiagnostics,
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
  it("returns the deletion lifecycle so the admin UI cannot present a suspended account as active", async () => {
    const accountLifecycle = {
      status: "deletion_scheduled",
      deletionId: "delete-uid-1",
      eraseAfter: 1_783_000_000_000,
    };
    const app = makeApp({
      "users/uid-1": customerDoc({ accountLifecycle }),
    });

    const res = await request(app).get("/api/admin/customer/uid-1").expect(200);

    expect(res.body.accountLifecycle).toEqual(accountLifecycle);
  });

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

describe("GET /api/admin/customers — search and filters cover every customer", () => {
  function directory(count: number): Record<string, DocData> {
    return Object.fromEntries(
      Array.from({ length: count }, (_, index) => {
        const name = `builder${String(index).padStart(2, "0")}`;
        return [`users/uid-${name}`, customerDoc({ username: name, email: `${name}@example.com`, displayName: name })];
      }),
    );
  }

  it("finds a customer beyond the first page", async () => {
    const res = await request(makeApp(directory(40)))
      .get("/api/admin/customers?search=builder33")
      .expect(200);

    expect(res.body.items.map((item: { username: string }) => item.username)).toEqual(["builder33"]);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBeNull();
  });

  it("pages through matches instead of through unfiltered rows", async () => {
    const app = makeApp(directory(40));

    const first = await request(app).get("/api/admin/customers?search=builder3&pageSize=4").expect(200);
    expect(first.body.items.map((item: { username: string }) => item.username)).toEqual([
      "builder30", "builder31", "builder32", "builder33",
    ]);
    expect(first.body.hasMore).toBe(true);

    const second = await request(app)
      .get(`/api/admin/customers?search=builder3&pageSize=4&cursor=${first.body.nextCursor}`)
      .expect(200);
    expect(second.body.items.map((item: { username: string }) => item.username)).toEqual([
      "builder34", "builder35", "builder36", "builder37",
    ]);
    expect(second.body.hasMore).toBe(true);
  });
});

describe("GET /api/admin/customer-archives", () => {
  it("returns retained operational totals while dropping unexpected identifying fields", async () => {
    const app = makeApp({
      "anonymousOperationalArchives/random-1": {
        schemaVersion: 1,
        archivedAt: 1_784_000_000_000,
        accountCreatedMonth: "2025-01",
        deletionRequestedMonth: "2026-07",
        environment: "must-not-leak@example.com",
        planTier: "must-not-leak@example.com",
        gatewayClass: "must-not-leak@example.com",
        totals: { costUsd: 12.34, totalTokens: 987_654, requestCount: 321 },
        models: [
          {
            provider: "anthropic",
            model: "sonnet",
            costUsd: 12.34,
            totalTokens: 987_654,
            requestCount: 321,
          },
          {
            provider: "must-not-leak@example.com",
            model: "must-not-leak@example.com",
            costUsd: 99,
            totalTokens: 99,
            requestCount: 99,
          },
        ],
        cleanupOutcomeCodes: ["verified_erasure"],
        uid: "must-not-leak",
        email: "must-not-leak@example.com",
      },
    });

    const res = await request(app).get("/api/admin/customer-archives").expect(200);

    expect(res.body.summary).toEqual({
      archiveCount: 1,
      totalCostUsd: 12.34,
      totalTokens: 987_654,
      requestCount: 321,
    });
    expect(res.body.archives[0]).toMatchObject({
      id: "random-1",
      environment: "unknown",
      planTier: null,
      gatewayClass: null,
      totals: { costUsd: 12.34, totalTokens: 987_654, requestCount: 321 },
    });
    expect(JSON.stringify(res.body)).not.toContain("must-not-leak");
    expect(res.body.archives[0].models).toEqual([{
      provider: "anthropic",
      model: "sonnet",
      costUsd: 12.34,
      totalTokens: 987_654,
      requestCount: 321,
    }]);
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

describe("GET /api/admin/customer/:uid — placement and parked computer", () => {
  it("projects the placement and the parked computer with its checkpoint state", async () => {
    const computer = {
      instanceName: "octogee-computer-prod-uid-1",
      zone: "us-central1-a",
      instanceId: "123",
      gatewayId: "alice-m-1",
      parkedAt: 1_800_000_000_000,
      checkpoint: { outcome: "fresh", requestedAt: 1_799_999_000_000, completedAt: 1_799_999_500_000 },
    };
    const app = makeApp({
      "users/uid-1": customerDoc({
        provisioning: {
          openclaw: { status: "complete", slug: "builder", gatewayId: "alice-m-1", gatewayProfile: "builder" },
          computer,
        },
      }),
    });

    const res = await request(app).get("/api/admin/customer/uid-1").expect(200);

    expect(res.body.placement).toEqual({ gatewayId: "alice-m-1", gatewayProfile: "builder" });
    expect(res.body.computer).toEqual(computer);
  });

  it("reports no placement and no computer when the user has never been placed", async () => {
    const app = makeApp({ "users/uid-1": customerDoc() });

    const res = await request(app).get("/api/admin/customer/uid-1").expect(200);

    expect(res.body.placement).toEqual({ gatewayId: null, gatewayProfile: null });
    expect(res.body.computer).toBeNull();
  });
});

describe("GET /api/admin/customer/:uid — broker-sourced usage", () => {
  it("uses reset budget charges while retaining actual historical cost totals", async () => {
    const now = Date.now();
    const app = makeApp({
      "users/uid-1": customerDoc({ subscription: { tier: "personal", status: "active" } }),
      [`modelBrokerUsageWindows/uid-1_${usageWindowStartMs(now)}`]: { costUsd: 10, chargeUsd: 0 },
      [`modelBrokerWeekWindows/uid-1_${weekWindowStartMs(now)}`]: { costUsd: 20, chargeUsd: 0 },
      "modelBrokerUsageRollups/uid-1": { costUsd: 50, totalTokens: 1000000 },
    });
    const res = await request(app).get("/api/admin/customer/uid-1").expect(200);
    expect(res.body.usage).toMatchObject({ windowCostUsd: 0, weekCostUsd: 0, costUsd: 50, degraded: false, percentUsed: 0 });
    expect(res.body.summary.weekPercentUsed).toBe(0);
  });
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

describe("aggregateBrokerDiagnostics — the where-did-my-window-go projection", () => {
  const JULY3 = Date.UTC(2026, 6, 3, 17);
  const ev = (over: Record<string, unknown>) => ({
    createdAt: JULY3,
    model: "claude-sonnet-4-6",
    totalTokens: 20_100,
    costUsd: 0.076,
    usage: { inputTokens: 3, outputTokens: 90, cacheCreationInputTokens: 20_009, cacheReadInputTokens: 0 },
    costBreakdown: { input: 0.0001, output: 0.0013, cacheRead: 0, cacheWrite: 0.075 },
    degraded: false,
    brokerTokenSecretName: "agent-model-token-canary-glm-blue-uid1",
    ...over,
  });

  it("aggregates per-day×model with cache-write share, decomposition, and newest-first recent calls", () => {
    const out = aggregateBrokerDiagnostics([
      ev({}),
      ev({ createdAt: JULY3 + 60_000, costUsd: 0.01, costBreakdown: { input: 0.0001, output: 0.0013, cacheRead: 0.006, cacheWrite: 0.002 }, usage: { inputTokens: 1, outputTokens: 88, cacheCreationInputTokens: 281, cacheReadInputTokens: 20_002 } }),
      ev({ createdAt: Date.UTC(2026, 6, 4, 1), model: "z-ai/glm-5.2", totalTokens: 15_600, costUsd: 0.016, costBreakdown: { input: 0.016, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      ev({ createdAt: 0 }), // no timestamp → excluded from days, not counted
    ]);

    expect(out.days).toEqual([
      expect.objectContaining({ date: "2026-07-03", model: "claude-sonnet-4-6", requestCount: 2, cacheWriteUsd: expect.closeTo(0.077, 5) }),
      expect.objectContaining({ date: "2026-07-04", model: "z-ai/glm-5.2", requestCount: 1 }),
    ]);
    expect(out.decomposition.cacheWrite).toBeCloseTo(0.077, 5);
    expect(out.decomposition.input).toBeCloseTo(0.0162, 5);
    expect(out.recentCalls[0]).toMatchObject({ model: "z-ai/glm-5.2", cacheWriteTokens: 20_009 });
    expect(out.recentCalls[1]).toMatchObject({ cacheReadTokens: 20_002, degraded: false });
    expect(out.recentCalls).toHaveLength(4);
    expect(out.recentCalls[2].brokerTokenSecretName).toContain("canary-glm-blue");
  });

  it("caps the recent-call list", () => {
    const out = aggregateBrokerDiagnostics(
      Array.from({ length: 40 }, (_, i) => ev({ createdAt: JULY3 + i })),
      25,
    );
    expect(out.recentCalls).toHaveLength(25);
    expect(out.recentCalls[0].at).toBe(JULY3 + 39);
  });
});

describe("GET /api/admin/customer/:uid/placements", () => {
  function receipt(overrides: DocData): DocData {
    return {
      schemaVersion: 1,
      kind: "activated",
      at: 1_000,
      builderSlug: "builder",
      leaseId: "lease-1",
      generation: 1,
      cause: "run-start",
      sizingTier: "xs",
      entitlementTier: "hobby",
      gatewayId: "builder-xs-feedf00d",
      sharedGatewayId: "default",
      requestedAt: 500,
      wakeDurationMs: 500,
      activeDurationMs: null,
      operationId: "builder-activate-builder-xs-feedf00d-g1",
      retirementOperationId: null,
      operatorTerminated: false,
      error: null,
      ...overrides,
    };
  }

  const failedLeaseUser = customerDoc({
    provisioning: {
      openclaw: {
        status: "complete",
        slug: "builder",
        gatewayId: "default",
        activationLease: {
          leaseId: "lease-2",
          generation: 2,
          status: "failed",
          cause: "run-start",
          sizingTier: "xs",
          targetGatewayId: "builder-xs-feedf00d",
          lastError: { message: "restore failed" },
        },
      },
    },
  });

  it("returns placement receipts newest-first with the lease and retry state", async () => {
    const app = makeApp({
      "users/uid-1": failedLeaseUser,
      "users/uid-1/placement_receipts/lease-1-1-activated": receipt({}),
      "users/uid-1/placement_receipts/lease-1-1-returned": receipt({
        kind: "returned",
        at: 2_000,
        activeDurationMs: 60_000,
        operationId: "builder-return-builder-xs-feedf00d-g1",
        retirementOperationId: "placement-retire-uid-1-builder-xs-feedf00d-g1",
      }),
      "users/uid-1/placement_receipts/lease-2-2-activation-failed": receipt({
        kind: "activation-failed",
        at: 3_000,
        leaseId: "lease-2",
        generation: 2,
        error: "restore failed",
      }),
    });

    const res = await request(app).get("/api/admin/customer/uid-1/placements").expect(200);

    expect(res.body.items.map((item: { kind: string }) => item.kind)).toEqual([
      "activation-failed",
      "returned",
      "activated",
    ]);
    expect(res.body.items[1]).toMatchObject({
      kind: "returned",
      gatewayId: "builder-xs-feedf00d",
      sharedGatewayId: "default",
      sizingTier: "xs",
      activeDurationMs: 60_000,
      operatorTerminated: false,
    });
    expect(res.body.lease).toMatchObject({
      leaseId: "lease-2",
      generation: 2,
      status: "failed",
      targetGatewayId: "builder-xs-feedf00d",
      error: "restore failed",
    });
    expect(res.body.hasMore).toBe(false);
    expect(res.body.retryAvailable).toBe(true);
  });

  it("truncates loudly with hasMore when history exceeds the requested limit", async () => {
    const app = makeApp({
      "users/uid-1": failedLeaseUser,
      "users/uid-1/placement_receipts/lease-1-1-activated": receipt({}),
      "users/uid-1/placement_receipts/lease-1-1-returned": receipt({ kind: "returned", at: 2_000 }),
      "users/uid-1/placement_receipts/lease-2-2-activation-failed": receipt({
        kind: "activation-failed",
        at: 3_000,
        leaseId: "lease-2",
        generation: 2,
      }),
    });

    const res = await request(app)
      .get("/api/admin/customer/uid-1/placements?limit=2")
      .expect(200);

    expect(res.body.items.map((item: { at: number }) => item.at)).toEqual([3_000, 2_000]);
    expect(res.body.hasMore).toBe(true);
  });

  it("withholds retry while the failed runtime record still exists", async () => {
    const app = makeApp({
      "users/uid-1": failedLeaseUser,
      "gateways/builder-xs-feedf00d": { gatewayId: "builder-xs-feedf00d", desiredStatus: "retired" },
    });

    const res = await request(app).get("/api/admin/customer/uid-1/placements").expect(200);

    expect(res.body.retryAvailable).toBe(false);
    expect(res.body.items).toEqual([]);
  });

  it("rejects an unknown customer", async () => {
    const app = makeApp({});
    await request(app).get("/api/admin/customer/uid-missing/placements").expect(404);
  });
});
