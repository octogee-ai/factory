import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

vi.mock("firebase-admin/firestore", async () => {
  const actual = await vi.importActual<any>("firebase-admin/firestore");
  return {
    ...actual,
    FieldValue: {
      increment: (n: number) => ({ __op: "increment", value: n }),
      arrayUnion: (...xs: any[]) => ({ __op: "arrayUnion", values: xs }),
      serverTimestamp: () => ({ __op: "serverTimestamp" }),
    },
  };
});

import { reportUsage } from "../lib/usage-tracking";

type WriteOp = { op: "set" | "update"; path: string; data: any; opts?: any };

function makeStubDb(userData: Record<string, any>) {
  const writes: WriteOp[] = [];
  const refPaths = new Set<string>();

  function makeDocRef(p: string): any {
    refPaths.add(p);
    return {
      _type: "doc",
      _path: p,
      collection: (sub: string) => makeCollRef(`${p}/${sub}`),
      get: async () => ({
        exists: true,
        data: () => userData,
      }),
    };
  }

  function makeCollRef(p: string): any {
    refPaths.add(p);
    return {
      _type: "coll",
      _path: p,
      doc: (id: string) => makeDocRef(`${p}/${id}`),
    };
  }

  return {
    db: {
      collection: (p: string) => makeCollRef(p),
      runTransaction: async (fn: (t: any) => Promise<void>) => {
        const t = {
          get: async (_ref: any) => ({
            exists: true,
            data: () => userData,
          }),
          set: (ref: any, data: any, opts?: any) => {
            writes.push({ op: "set", path: ref._path, data, opts });
          },
          update: (ref: any, data: any) => {
            writes.push({ op: "update", path: ref._path, data });
          },
        };
        await fn(t);
      },
    },
    writes,
    refPaths,
  };
}

function makeAgentDir(slug: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-"));
  fs.writeFileSync(
    path.join(dir, "customer-config.json"),
    JSON.stringify({ slug }),
  );
  return dir;
}

describe("reportUsage — v3.1 workspace paths", () => {
  it("writes to workspaces/{slug}/usage_{sessions,models,summary} (and not the deprecated user-subtree)", async () => {
    const { db, writes } = makeStubDb({
      selectedTier: "pro",
      subscription: { tier: "pro" },
      usage: {},
    });
    const agentDir = makeAgentDir("eckert");

    await reportUsage(
      db as any,
      "octogee-eckert-coach",
      "coach",
      agentDir,
      {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        costUsd: 0.002,
        model: "anthropic/claude-haiku-4-5",
        costBreakdown: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0 },
      },
      new Map([["octogee-eckert-coach", "eckert-uid"]]),
      () => {},
      "gw-test",
    );

    const today = new Date().toISOString().slice(0, 10);

    const paths = writes.map((w) => w.path);

    expect(paths).toContain(`workspaces/eckert/usage_sessions/${today}`);
    expect(paths).toContain(`workspaces/eckert/usage_models/anthropic_claude-haiku-4-5_${today}`);
    expect(paths).toContain("workspaces/eckert/usage_summary/current");

    const deprecated = paths.filter((p) =>
      /^users\/[^/]+\/workspaces\/[^/]+\/usage/.test(p),
    );
    expect(deprecated).toEqual([]);
  });

  it("session + model docs carry (role, model, slug, gateway, tokens, cost) — no per-turn key fingerprint", async () => {
    const { db, writes } = makeStubDb({
      selectedTier: "pro",
      usage: {},
    });
    const agentDir = makeAgentDir("christopher");

    await reportUsage(
      db as any,
      "octogee-christopher-coach",
      "brain",
      agentDir,
      {
        input: 10, output: 20, cacheRead: 5, cacheWrite: 0,
        totalTokens: 35, costUsd: 0.01, model: "anthropic/claude-sonnet-4-6",
        costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      new Map([["octogee-christopher-coach", "chris-uid"]]),
      () => {},
      "gw-test",
    );

    const today = new Date().toISOString().slice(0, 10);
    const sessionWrite = writes.find((w) => w.path === `workspaces/christopher/usage_sessions/${today}`);
    const modelWrite   = writes.find((w) => w.path.startsWith("workspaces/christopher/usage_models/"));
    const summaryWrite = writes.find((w) => w.path === "workspaces/christopher/usage_summary/current");

    expect(sessionWrite).toBeDefined();
    expect(modelWrite).toBeDefined();
    expect(summaryWrite).toBeDefined();

    expect(sessionWrite!.data.gatewayId).toBe("gw-test");
    expect(sessionWrite!.data.workspaceId).toBe("christopher");
    expect(sessionWrite!.data.tokensUsed).toEqual({ __op: "increment", value: 35 });
    expect(sessionWrite!.data.costUsd).toEqual({ __op: "increment", value: 0.01 });
    expect(sessionWrite!.data.interactions).toEqual({ __op: "increment", value: 1 });
    expect(sessionWrite!.data["roles.brain"]).toEqual({ __op: "increment", value: 35 });
    expect(sessionWrite!.data["token_breakdown.input"]).toEqual({ __op: "increment", value: 10 });
    expect(sessionWrite!.data["token_breakdown.output"]).toEqual({ __op: "increment", value: 20 });
    expect(sessionWrite!.data["token_breakdown.cacheRead"]).toEqual({ __op: "increment", value: 5 });

    expect(modelWrite!.data.model).toBe("anthropic/claude-sonnet-4-6");
    expect(modelWrite!.data.role).toBe("brain");
    expect(modelWrite!.data.workspaceId).toBe("christopher");
    expect(modelWrite!.data.tokens).toEqual({ __op: "increment", value: 35 });
    expect(modelWrite!.data.cost_usd).toEqual({ __op: "increment", value: 0.01 });
    expect(modelWrite!.data.interaction_count).toEqual({ __op: "increment", value: 1 });

    expect(summaryWrite!.data.workspaceId).toBe("christopher");
    expect(summaryWrite!.data.totalTokens).toEqual({ __op: "increment", value: 35 });
    expect(summaryWrite!.data.totalCostUsd).toEqual({ __op: "increment", value: 0.01 });
    expect(summaryWrite!.data.totalInteractions).toEqual({ __op: "increment", value: 1 });
    expect(summaryWrite!.data["modelCosts.anthropic_claude-sonnet-4-6"]).toEqual({
      __op: "increment",
      value: 0.01,
    });

    for (const w of [sessionWrite!, modelWrite!, summaryWrite!]) {
      expect(w.data).not.toHaveProperty("keyFingerprint");
      expect(w.data).not.toHaveProperty("keyFingerprints");
      expect(w.data).not.toHaveProperty("lastKeyFingerprint");
    }
  });

  it("user-level write does NOT carry lastKeyFingerprint", async () => {
    const { db, writes } = makeStubDb({
      selectedTier: "pro",
      usage: {},
    });
    const agentDir = makeAgentDir("eckert");

    await reportUsage(
      db as any,
      "octogee-eckert-coach",
      "coach",
      agentDir,
      {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
        totalTokens: 2, costUsd: 0.0001, model: "anthropic/claude-haiku-4-5",
        costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      new Map([["octogee-eckert-coach", "eckert-uid"]]),
      () => {},
      "gw-test",
    );

    const today = new Date().toISOString().slice(0, 10);
    const userUpdate = writes.find((w) => w.path === "users/eckert-uid" && w.op === "update");
    const logSet = writes.find((w) => w.path === `users/eckert-uid/usage_logs/${today}`);

    expect(userUpdate).toBeDefined();
    expect(userUpdate!.data).not.toHaveProperty("usage.lastKeyFingerprint");
    expect(userUpdate!.data["usage.totalTokensUsed"]).toBeDefined();

    expect(logSet).toBeDefined();
    expect(logSet!.data).not.toHaveProperty("keyFingerprint");
    expect(logSet!.data).not.toHaveProperty("keyFingerprints");
    expect(logSet!.data.date).toBe(today);
  });

  it("skips all writes when agent has no known uid (agentToUid miss)", async () => {
    const { db, writes } = makeStubDb({});
    const agentDir = makeAgentDir("eckert");

    await reportUsage(
      db as any,
      "octogee-unknown-coach",
      "coach",
      agentDir,
      {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
        totalTokens: 2, costUsd: 0.0001, model: "anthropic/claude-haiku-4-5",
        costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      new Map(),
      () => {},
      "gw-test",
    );

    expect(writes).toEqual([]);
  });

  it("free-tier customer: throttleLevel forced to 3 (always on house key, §9.5)", async () => {
    const { db, writes } = makeStubDb({
      selectedTier: "free",
      subscription: { tier: "free", status: "active" },
      byotActive: false,
      usage: {
        windowCostUsd: 0,
        windowStartedAt: { toDate: () => new Date(Date.now() - 1 * 60 * 60 * 1000) },
      },
    });
    const agentDir = makeAgentDir("free-customer");

    await reportUsage(
      db as any,
      "octogee-free-customer-coach",
      "coach",
      agentDir,
      {
        input: 100, output: 50, cacheRead: 0, cacheWrite: 0,
        totalTokens: 150, costUsd: 0.001,
        model: "anthropic/claude-haiku-4-5",
        costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      new Map([["octogee-free-customer-coach", "free-uid"]]),
      () => {},
      "gw-test",
    );

    const userUpdate = writes.find((w) => w.path === "users/free-uid" && w.op === "update");
    expect(userUpdate).toBeDefined();
    expect(userUpdate!.data["usage.throttleLevel"]).toBe(3);
    expect(userUpdate!.data["usage.throttleReason"]).toBe("free_tier_house_key");
  });

  it("BYOT customer: tracks cost but throttleLevel stays 0 even at 200% of budget", async () => {
    const { db, writes } = makeStubDb({
      selectedTier: "hobby",
      subscription: { tier: "hobby" },
      byotActive: true,
      usage: {
        windowCostUsd: 100,
        windowStartedAt: { toDate: () => new Date(Date.now() - 1 * 60 * 60 * 1000) },
      },
    });
    const agentDir = makeAgentDir("byot-customer");

    await reportUsage(
      db as any,
      "octogee-byot-customer-coach",
      "coach",
      agentDir,
      {
        input: 1000, output: 500, cacheRead: 0, cacheWrite: 0,
        totalTokens: 1500, costUsd: 50.0,
        model: "anthropic/claude-sonnet-4-6",
        costBreakdown: { input: 25, output: 25, cacheRead: 0, cacheWrite: 0 },
      },
      new Map([["octogee-byot-customer-coach", "byot-uid"]]),
      () => {},
      "gw-test",
    );

    const userUpdate = writes.find((w) => w.path === "users/byot-uid" && w.op === "update");
    expect(userUpdate).toBeDefined();
    expect(userUpdate!.data["usage.throttleLevel"]).toBe(0);
    expect(userUpdate!.data["usage.windowCostUsd"]).toBeDefined();
  });

  it("non-BYOT customer past 100% USD budget: throttleLevel = 3 (plan demoted)", async () => {
    const { db, writes } = makeStubDb({
      selectedTier: "hobby",
      subscription: { tier: "hobby", status: "active" },
      byotActive: false,
      usage: {
        windowCostUsd: 0.0,
        windowStartedAt: { toDate: () => new Date(Date.now() - 1 * 60 * 60 * 1000) },
      },
    });
    const agentDir = makeAgentDir("paid-customer");

    await reportUsage(
      db as any,
      "octogee-paid-customer-coach",
      "coach",
      agentDir,
      {
        input: 100_000, output: 100_000, cacheRead: 0, cacheWrite: 0,
        totalTokens: 200_000, costUsd: 5.0,
        model: "anthropic/claude-sonnet-4-6",
        costBreakdown: { input: 2.5, output: 2.5, cacheRead: 0, cacheWrite: 0 },
      },
      new Map([["octogee-paid-customer-coach", "paid-uid"]]),
      () => {},
      "gw-test",
    );

    const userUpdate = writes.find((w) => w.path === "users/paid-uid" && w.op === "update");
    expect(userUpdate).toBeDefined();
    expect(userUpdate!.data["usage.throttleLevel"]).toBe(3);
    expect(userUpdate!.data["usage.throttleLevel"]).not.toBe(2);
  });

  it("skips workspace-scoped writes when customer-config.json has no slug", async () => {
    const { db, writes } = makeStubDb({
      selectedTier: "pro",
      usage: {},
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-"));
    fs.writeFileSync(path.join(dir, "customer-config.json"), JSON.stringify({}));

    await reportUsage(
      db as any,
      "octogee-eckert-coach",
      "coach",
      dir,
      {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
        totalTokens: 2, costUsd: 0.0001, model: "anthropic/claude-haiku-4-5",
        costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      new Map([["octogee-eckert-coach", "eckert-uid"]]),
      () => {},
      "gw-test",
    );

    const wsWrites = writes.filter((w) => w.path.startsWith("workspaces/"));
    expect(wsWrites).toEqual([]);

    const legacyWrites = writes.filter((w) => w.path.startsWith("users/"));
    expect(legacyWrites.length).toBeGreaterThan(0);
  });
});
