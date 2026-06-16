import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8088";
process.env.GCLOUD_PROJECT ??= "octogee-test";

const adminMod = await import("firebase-admin");
const admin = adminMod.default;
if (admin.apps.length === 0) admin.initializeApp({ projectId: "octogee-test" });
const db = admin.firestore();

const { reportUsage } = await import("../lib/usage-tracking.js");

async function recursiveClear(coll: string): Promise<void> {

const refs = await db.collection(coll).listDocuments();
  const CHUNK = 10;
  for (let i = 0; i < refs.length; i += CHUNK) {
    await Promise.all(
      refs.slice(i, i + CHUNK).map((r) => db.recursiveDelete(r)),
    );
  }
}

beforeEach(async () => {
  await Promise.all([recursiveClear("users"), recursiveClear("workspaces")]);
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app?.delete()));
});

function makeAgentDir(_slug: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-"));
  return dir;
}

async function seedUser(uid: string, data: Record<string, unknown>): Promise<void> {
  await db.collection("users").doc(uid).set(data);
}

async function readDoc(p: string): Promise<Record<string, unknown> | null> {
  const snap = await db.doc(p).get();
  return snap.exists ? (snap.data() as Record<string, unknown>) : null;
}

const today = new Date().toISOString().slice(0, 10);

describe("reportUsage — v3.1 workspace paths", () => {
  it("writes to workspaces/{slug}/usage_{sessions,models,summary} (and not the deprecated user-subtree)", async () => {
    await seedUser("eckert-uid", {
      selectedTier: "pro",
      subscription: { tier: "pro" },
      usage: {},
    });
    const agentDir = makeAgentDir("eckert");

    await reportUsage({
      db: db as never,
      agentId: "octogee-eckert-coach",
      role: "coach",
      agentDir,
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        costUsd: 0.002,
        model: "anthropic/claude-haiku-4-5",
        costBreakdown: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0 },
      },
      agentToUid: new Map([["octogee-eckert-coach", "eckert-uid"]]),
      log: () => {},
      gatewayId: "gw-test",
    });

    expect(await readDoc(`workspaces/eckert/usage_sessions/${today}`)).not.toBeNull();
    expect(
      await readDoc(`workspaces/eckert/usage_models/anthropic_claude-haiku-4-5_${today}`),
    ).not.toBeNull();
    expect(await readDoc("workspaces/eckert/usage_summary/current")).not.toBeNull();

    const deprecatedSnap = await db
      .collection("users")
      .doc("eckert-uid")
      .collection("workspaces")
      .get();
    expect(deprecatedSnap.empty).toBe(true);
  });

it("session + model + summary docs carry (role, model, slug, gateway, tokens, cost) — no per-turn key fingerprint", async () => {
    await seedUser("chris-uid", { selectedTier: "pro", usage: {} });
    const agentDir = makeAgentDir("christopher");

    await reportUsage({
      db: db as never,
      agentId: "octogee-christopher-coach",
      role: "brain",
      agentDir,
      usage: {
        input: 10,
        output: 20,
        cacheRead: 5,
        cacheWrite: 0,
        totalTokens: 35,
        costUsd: 0.01,
        model: "anthropic/claude-sonnet-4-6",
        costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      agentToUid: new Map([["octogee-christopher-coach", "chris-uid"]]),
      log: () => {},
      gatewayId: "gw-test",
    });

    const session = await readDoc(`workspaces/christopher/usage_sessions/${today}`);
    const model = await readDoc(
      `workspaces/christopher/usage_models/anthropic_claude-sonnet-4-6_${today}`,
    );
    const summary = await readDoc("workspaces/christopher/usage_summary/current");

    expect(session).not.toBeNull();
    expect(model).not.toBeNull();
    expect(summary).not.toBeNull();

    expect(session?.gatewayId).toBe("gw-test");
    expect(session?.workspaceId).toBe("christopher");
    expect(session?.tokensUsed).toBe(35);
    expect(session?.costUsd).toBeCloseTo(0.01);
    expect(session?.interactions).toBe(1);
    expect((session?.roles as Record<string, number>)?.brain).toBe(35);
    expect((session?.token_breakdown as Record<string, number>)?.input).toBe(10);
    expect((session?.token_breakdown as Record<string, number>)?.output).toBe(20);
    expect((session?.token_breakdown as Record<string, number>)?.cacheRead).toBe(5);

    expect(model?.model).toBe("anthropic/claude-sonnet-4-6");
    expect(model?.role).toBe("brain");
    expect(model?.workspaceId).toBe("christopher");
    expect(model?.tokens).toBe(35);
    expect(model?.cost_usd).toBeCloseTo(0.01);
    expect(model?.interaction_count).toBe(1);

    expect(summary?.workspaceId).toBe("christopher");
    expect(summary?.totalTokens).toBe(35);
    expect(summary?.totalCostUsd).toBeCloseTo(0.01);
    expect(summary?.totalInteractions).toBe(1);
    expect(
      (summary?.modelCosts as Record<string, number>)["anthropic_claude-sonnet-4-6"],
    ).toBeCloseTo(0.01);

    for (const doc of [session, model, summary]) {
      expect(doc).not.toHaveProperty("keyFingerprint");
      expect(doc).not.toHaveProperty("keyFingerprints");
      expect(doc).not.toHaveProperty("lastKeyFingerprint");
    }
  });

  it("user-level write does NOT carry lastKeyFingerprint", async () => {
    await seedUser("eckert-uid", { selectedTier: "pro", usage: {} });
    const agentDir = makeAgentDir("eckert");

    await reportUsage({
      db: db as never,
      agentId: "octogee-eckert-coach",
      role: "coach",
      agentDir,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        costUsd: 0.0001,
        model: "anthropic/claude-haiku-4-5",
        costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      agentToUid: new Map([["octogee-eckert-coach", "eckert-uid"]]),
      log: () => {},
      gatewayId: "gw-test",
    });

    const user = await readDoc("users/eckert-uid");
    expect(user?.usage).toBeDefined();
    expect((user?.usage as Record<string, unknown>).lastKeyFingerprint).toBeUndefined();
    expect((user?.usage as Record<string, unknown>).totalTokensUsed).toBeDefined();

    const log = await readDoc(`users/eckert-uid/usage_logs/${today}`);
    expect(log).not.toBeNull();
    expect(log).not.toHaveProperty("keyFingerprint");
    expect(log).not.toHaveProperty("keyFingerprints");
    expect(log?.date).toBe(today);
  });

  it("skips all writes when agent has no known uid (agentToUid miss)", async () => {
    const agentDir = makeAgentDir("eckert");

    await reportUsage({
      db: db as never,
      agentId: "octogee-unknown-coach",
      role: "coach",
      agentDir,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        costUsd: 0.0001,
        model: "anthropic/claude-haiku-4-5",
        costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      agentToUid: new Map(),
      log: () => {},
      gatewayId: "gw-test",
    });

    const usersSnap = await db.collection("users").get();
    expect(usersSnap.empty).toBe(true);
    const wsSnap = await db.collection("workspaces").get();
    expect(wsSnap.empty).toBe(true);
  });

  it("free-tier customer: throttleLevel forced to 3 (always on house key, §9.5)", async () => {
    await seedUser("free-uid", {
      selectedTier: "free",
      subscription: { tier: "free", status: "active" },
      byotActive: false,
      usage: {
        windowCostUsd: 0,
        windowStartedAt: admin.firestore.Timestamp.fromDate(
          new Date(Date.now() - 1 * 60 * 60 * 1000),
        ),
      },
    });
    const agentDir = makeAgentDir("free-customer");

    await reportUsage({
      db: db as never,
      agentId: "octogee-free-customer-coach",
      role: "coach",
      agentDir,
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        costUsd: 0.001,
        model: "anthropic/claude-haiku-4-5",
        costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      agentToUid: new Map([["octogee-free-customer-coach", "free-uid"]]),
      log: () => {},
      gatewayId: "gw-test",
    });

    const user = await readDoc("users/free-uid");
    const usage = user?.usage as Record<string, unknown>;
    expect(usage.throttleLevel).toBe(3);
    expect(usage.throttleReason).toBe("free_tier_house_key");
  });

  it("BYOT customer: tracks cost but throttleLevel stays 0 even at 200% of budget", async () => {
    await seedUser("byot-uid", {
      selectedTier: "hobby",
      subscription: { tier: "hobby" },
      byotActive: true,
      usage: {
        windowCostUsd: 100,
        windowStartedAt: admin.firestore.Timestamp.fromDate(
          new Date(Date.now() - 1 * 60 * 60 * 1000),
        ),
      },
    });
    const agentDir = makeAgentDir("byot-customer");

    await reportUsage({
      db: db as never,
      agentId: "octogee-byot-customer-coach",
      role: "coach",
      agentDir,
      usage: {
        input: 1000,
        output: 500,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1500,
        costUsd: 50.0,
        model: "anthropic/claude-sonnet-4-6",
        costBreakdown: { input: 25, output: 25, cacheRead: 0, cacheWrite: 0 },
      },
      agentToUid: new Map([["octogee-byot-customer-coach", "byot-uid"]]),
      log: () => {},
      gatewayId: "gw-test",
    });

    const user = await readDoc("users/byot-uid");
    const usage = user?.usage as Record<string, unknown>;
    expect(usage.throttleLevel).toBe(0);
    expect(usage.windowCostUsd).toBeDefined();
  });

  it("non-BYOT customer past 100% USD budget: throttleLevel = 3 (plan demoted)", async () => {
    await seedUser("paid-uid", {
      selectedTier: "hobby",
      subscription: { tier: "hobby", status: "active" },
      byotActive: false,
      usage: {
        windowCostUsd: 0.0,
        windowStartedAt: admin.firestore.Timestamp.fromDate(
          new Date(Date.now() - 1 * 60 * 60 * 1000),
        ),
      },
    });
    const agentDir = makeAgentDir("paid-customer");

    await reportUsage({
      db: db as never,
      agentId: "octogee-paid-customer-coach",
      role: "coach",
      agentDir,
      usage: {
        input: 100_000,
        output: 100_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 200_000,
        costUsd: 5.0,
        model: "anthropic/claude-sonnet-4-6",
        costBreakdown: { input: 2.5, output: 2.5, cacheRead: 0, cacheWrite: 0 },
      },
      agentToUid: new Map([["octogee-paid-customer-coach", "paid-uid"]]),
      log: () => {},
      gatewayId: "gw-test",
    });

    const user = await readDoc("users/paid-uid");
    const usage = user?.usage as Record<string, unknown>;
    expect(usage.throttleLevel).toBe(3);
    expect(usage.throttleLevel).not.toBe(2);
  });

  it("skips workspace-scoped writes when user state and agent id cannot identify a workspace", async () => {
    await seedUser("eckert-uid", { selectedTier: "pro", usage: {} });
    const dir = makeAgentDir(null);

    await reportUsage({
      db: db as never,
      agentId: "badagent",
      role: "coach",
      agentDir: dir,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        costUsd: 0.0001,
        model: "anthropic/claude-haiku-4-5",
        costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      agentToUid: new Map([["badagent", "eckert-uid"]]),
      log: () => {},
      gatewayId: "gw-test",
    });

    const wsSnap = await db.collection("workspaces").get();
    expect(wsSnap.empty).toBe(true);

    const user = await readDoc("users/eckert-uid");
    expect(user?.usage).toBeDefined();
  });
});

describe("reportUsage — nested-object contract (no dotted-literal field names)", () => {
  function baseUsage(overrides: Partial<{
    input: number; output: number; cacheRead: number; cacheWrite: number;
    totalTokens: number; costUsd: number; model: string;
    costBreakdown: { input: number; output: number; cacheRead: number; cacheWrite: number };
  }> = {}) {
    return {
      input: 10,
      output: 20,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 35,
      costUsd: 0.01,
      model: "anthropic/claude-sonnet-4-6",
      costBreakdown: { input: 0.004, output: 0.005, cacheRead: 0.001, cacheWrite: 0 },
      ...overrides,
    };
  }

  async function callOnce(opts: {
    uid: string;
    slug: string;
    role: string;
    usage?: ReturnType<typeof baseUsage>;
  }) {
    await seedUser(opts.uid, { selectedTier: "pro", usage: {} });
    const agentDir = makeAgentDir(opts.slug);
    await reportUsage({
      db: db as never,
      agentId: `octogee-${opts.slug}-coach`,
      role: opts.role,
      agentDir,
      usage: opts.usage ?? baseUsage(),
      agentToUid: new Map([[`octogee-${opts.slug}-coach`, opts.uid]]),
      log: () => {},
      gatewayId: "gw-test",
    });
  }

  it("usage_sessions: roles is a NESTED object (not a 'roles.<role>' literal field)", async () => {
    await callOnce({ uid: "u1", slug: "alice", role: "coach" });
    const session = await readDoc(`workspaces/alice/usage_sessions/${today}`);
    expect(session?.roles).toBeTypeOf("object");
    expect((session?.roles as Record<string, number>).coach).toBe(35);
    
    expect(Object.keys(session ?? {})).not.toContain("roles.coach");
  });

  it("usage_sessions: token_breakdown is a NESTED object (not 'token_breakdown.input' literals)", async () => {
    await callOnce({ uid: "u1", slug: "alice", role: "coach" });
    const session = await readDoc(`workspaces/alice/usage_sessions/${today}`);
    expect(session?.token_breakdown).toBeTypeOf("object");
    const tb = session?.token_breakdown as Record<string, number>;
    expect(tb.input).toBe(10);
    expect(tb.output).toBe(20);
    expect(tb.cacheRead).toBe(5);
    expect(tb.cacheWrite).toBe(0);
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
      expect(Object.keys(session ?? {})).not.toContain(`token_breakdown.${k}`);
    }
  });

  it("usage_models: token_breakdown is a NESTED object", async () => {
    await callOnce({ uid: "u1", slug: "alice", role: "coach" });
    const model = await readDoc(
      `workspaces/alice/usage_models/anthropic_claude-sonnet-4-6_${today}`,
    );
    expect(model?.token_breakdown).toBeTypeOf("object");
    const tb = model?.token_breakdown as Record<string, number>;
    expect(tb.input).toBe(10);
    expect(tb.output).toBe(20);
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
      expect(Object.keys(model ?? {})).not.toContain(`token_breakdown.${k}`);
    }
  });

  it("usage_summary: modelCosts is a NESTED object (not 'modelCosts.<modelKey>' literal)", async () => {
    await callOnce({ uid: "u1", slug: "alice", role: "coach" });
    const summary = await readDoc("workspaces/alice/usage_summary/current");
    expect(summary?.modelCosts).toBeTypeOf("object");
    const mc = summary?.modelCosts as Record<string, number>;
    expect(mc["anthropic_claude-sonnet-4-6"]).toBeCloseTo(0.01);
    expect(Object.keys(summary ?? {})).not.toContain(
      "modelCosts.anthropic_claude-sonnet-4-6",
    );
  });

  it("users/{uid}/usage_logs: breakdown is a NESTED object (not 'breakdown.<role>' / 'breakdown.input' literals)", async () => {
    await callOnce({ uid: "u1", slug: "alice", role: "coach" });
    const log = await readDoc(`users/u1/usage_logs/${today}`);
    expect(log?.breakdown).toBeTypeOf("object");
    const bd = log?.breakdown as Record<string, number>;
    expect(bd.coach).toBe(35);   
    expect(bd.input).toBe(10);
    expect(bd.output).toBe(20);
    expect(bd.cacheRead).toBe(5);
    expect(bd.costInput).toBeCloseTo(0.004);
    expect(bd.costOutput).toBeCloseTo(0.005);
    expect(bd.costCacheRead).toBeCloseTo(0.001);
    for (const k of ["coach", "input", "output", "cacheRead", "cacheWrite",
                     "costInput", "costOutput", "costCacheRead", "costCacheWrite"]) {
      expect(Object.keys(log ?? {})).not.toContain(`breakdown.${k}`);
    }
  });

it("no doc written by reportUsage has any top-level field name containing `.`", async () => {
    await callOnce({ uid: "u1", slug: "alice", role: "coach" });
    const docs = await Promise.all([
      readDoc(`users/u1/usage_logs/${today}`),
      readDoc(`workspaces/alice/usage_sessions/${today}`),
      readDoc(`workspaces/alice/usage_models/anthropic_claude-sonnet-4-6_${today}`),
      readDoc("workspaces/alice/usage_summary/current"),
    ]);
    for (const [i, doc] of docs.entries()) {
      const dotted = Object.keys(doc ?? {}).filter((k) => k.includes("."));
      expect(dotted, `doc[${i}] has dotted-literal keys: ${dotted.join(", ")}`)
        .toEqual([]);
    }
  });
});

describe("reportUsage — accumulation across multiple calls", () => {
  it("two coach calls on the same workspace+date double session totals (FieldValue.increment works)", async () => {
    await seedUser("u-acc", { selectedTier: "pro", usage: {} });
    const agentDir = makeAgentDir("acme");
    for (let i = 0; i < 2; i++) {
      await reportUsage({
        db: db as never,
        agentId: "octogee-acme-coach",
        role: "coach",
        agentDir,
        usage: {
          input: 10, output: 20, cacheRead: 5, cacheWrite: 0,
          totalTokens: 35, costUsd: 0.01,
          model: "anthropic/claude-sonnet-4-6",
          costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        agentToUid: new Map([["octogee-acme-coach", "u-acc"]]),
        log: () => {},
        gatewayId: "gw-test",
      });
    }
    const session = await readDoc(`workspaces/acme/usage_sessions/${today}`);
    expect(session?.tokensUsed).toBe(70);
    expect(session?.interactions).toBe(2);
    expect(session?.costUsd).toBeCloseTo(0.02);
    expect((session?.roles as Record<string, number>).coach).toBe(70);
  });

  it("two calls with DIFFERENT roles populate distinct roles.* entries (both accumulate to session.tokensUsed)", async () => {
    await seedUser("u-roles", { selectedTier: "pro", usage: {} });
    const agentDirCoach = makeAgentDir("acme");
    const agentDirBrain = makeAgentDir("acme");
    await reportUsage({
      db: db as never,
      agentId: "octogee-acme-coach",
      role: "coach",
      agentDir: agentDirCoach,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        totalTokens: 35, costUsd: 0.01,
        model: "anthropic/claude-sonnet-4-6",
        costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      agentToUid: new Map([["octogee-acme-coach", "u-roles"]]),
      log: () => {},
      gatewayId: "gw-test",
    });
    await reportUsage({
      db: db as never,
      agentId: "octogee-acme-coach",
      role: "brain",
      agentDir: agentDirBrain,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        totalTokens: 100, costUsd: 0.05,
        model: "anthropic/claude-sonnet-4-6",
        costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      agentToUid: new Map([["octogee-acme-coach", "u-roles"]]),
      log: () => {},
      gatewayId: "gw-test",
    });
    const session = await readDoc(`workspaces/acme/usage_sessions/${today}`);
    const roles = session?.roles as Record<string, number>;
    expect(roles.coach).toBe(35);
    expect(roles.brain).toBe(100);
    expect(session?.tokensUsed).toBe(135);
  });

  it("two calls with DIFFERENT models populate distinct summary.modelCosts.* entries", async () => {
    await seedUser("u-models", { selectedTier: "pro", usage: {} });
    const agentDir = makeAgentDir("acme");
    for (const m of ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5"]) {
      await reportUsage({
        db: db as never,
        agentId: "octogee-acme-coach",
        role: "coach",
        agentDir,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: 1, costUsd: m.includes("haiku") ? 0.001 : 0.01,
          model: m,
          costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        agentToUid: new Map([["octogee-acme-coach", "u-models"]]),
        log: () => {},
        gatewayId: "gw-test",
      });
    }
    const summary = await readDoc("workspaces/acme/usage_summary/current");
    const mc = summary?.modelCosts as Record<string, number>;
    expect(mc["anthropic_claude-sonnet-4-6"]).toBeCloseTo(0.01);
    expect(mc["anthropic_claude-haiku-4-5"]).toBeCloseTo(0.001);
    expect(summary?.totalCostUsd).toBeCloseTo(0.011);
  });

  it("token_breakdown accumulates across two calls on the same role+model+date", async () => {
    await seedUser("u-tb", { selectedTier: "pro", usage: {} });
    const agentDir = makeAgentDir("acme");
    for (let i = 0; i < 2; i++) {
      await reportUsage({
        db: db as never,
        agentId: "octogee-acme-coach",
        role: "coach",
        agentDir,
        usage: {
          input: 10, output: 20, cacheRead: 5, cacheWrite: 2,
          totalTokens: 37, costUsd: 0.01,
          model: "anthropic/claude-sonnet-4-6",
          costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        agentToUid: new Map([["octogee-acme-coach", "u-tb"]]),
        log: () => {},
        gatewayId: "gw-test",
      });
    }
    const session = await readDoc(`workspaces/acme/usage_sessions/${today}`);
    const tb = session?.token_breakdown as Record<string, number>;
    expect(tb.input).toBe(20);
    expect(tb.output).toBe(40);
    expect(tb.cacheRead).toBe(10);
    expect(tb.cacheWrite).toBe(4);
  });
});

describe("reportUsage — privacy invariants (no key-fingerprint fields)", () => {
  it("workspace session/model/summary docs carry no keyFingerprint / keyFingerprints / lastKeyFingerprint", async () => {
    await seedUser("u-priv", { selectedTier: "pro", usage: {} });
    const agentDir = makeAgentDir("acme");
    await reportUsage({
      db: db as never,
      agentId: "octogee-acme-coach",
      role: "coach",
      agentDir,
      usage: {
        input: 10, output: 20, cacheRead: 5, cacheWrite: 0,
        totalTokens: 35, costUsd: 0.01,
        model: "anthropic/claude-sonnet-4-6",
        costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      agentToUid: new Map([["octogee-acme-coach", "u-priv"]]),
      log: () => {},
      gatewayId: "gw-test",
    });
    const docs = await Promise.all([
      readDoc(`workspaces/acme/usage_sessions/${today}`),
      readDoc(`workspaces/acme/usage_models/anthropic_claude-sonnet-4-6_${today}`),
      readDoc("workspaces/acme/usage_summary/current"),
    ]);
    for (const doc of docs) {
      expect(doc).not.toHaveProperty("keyFingerprint");
      expect(doc).not.toHaveProperty("keyFingerprints");
      expect(doc).not.toHaveProperty("lastKeyFingerprint");
    }
  });
});
