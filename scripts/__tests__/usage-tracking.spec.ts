/**
 * usage-tracking — writer path tests.
 *
 * Pins the v3.1 Firestore paths so a regression to the old
 * `users/{uid}/workspaces/{wid}/usage/*` schema (which silently wrote
 * nothing because of invalid segment counts) fails loudly.
 *
 * We stub just enough of the Firestore Admin SDK to:
 *   - Record every `.doc()` path ever referenced
 *   - Record every `t.set()` / `t.update()` with (path, data) tuples
 *   - Return a plausible user doc from `t.get(userRef)`
 *
 * Then we call reportUsage() once and assert:
 *   - Exactly the three v3.1 paths were written
 *   - The BYOT fields (role, model, keyFingerprint, keyFingerprints) land
 *     where expected on both usage_sessions and usage_models
 *   - The deprecated user-subtree workspace path is never touched
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Unwrap FieldValue sentinels so assertions can see the actual numbers
// written. Without this, FieldValue.increment(150) is an opaque object and
// a regression that swapped `usage.totalTokens` for `usage.input` (150 → 100)
// would sail through the test.
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

/** Writes a minimal customer-config.json into a throwaway dir so
 * readWorkspaceId() returns the test slug. */
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
      "octogee-eckert-coach",          // agentId
      "coach",                          // role
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
      () => {},                         // log
      "gw-test",
      "sk-ant…abcd",                    // platform key fingerprint
    );

    const today = new Date().toISOString().slice(0, 10);

    const paths = writes.map((w) => w.path);

    // v3.1 writes land at these exact paths
    expect(paths).toContain(`workspaces/eckert/usage_sessions/${today}`);
    expect(paths).toContain(`workspaces/eckert/usage_models/anthropic_claude-haiku-4-5_${today}`);
    expect(paths).toContain("workspaces/eckert/usage_summary/current");

    // Deprecated user-subtree workspace path is never used
    const deprecated = paths.filter((p) =>
      /^users\/[^/]+\/workspaces\/[^/]+\/usage/.test(p),
    );
    expect(deprecated).toEqual([]);
  });

  it("carries BYOT attribution on session + model docs", async () => {
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
      "sk-byot…wxyz",
    );

    const today = new Date().toISOString().slice(0, 10);
    const sessionWrite = writes.find((w) => w.path === `workspaces/christopher/usage_sessions/${today}`);
    const modelWrite   = writes.find((w) => w.path.startsWith("workspaces/christopher/usage_models/"));
    const summaryWrite = writes.find((w) => w.path === "workspaces/christopher/usage_summary/current");

    expect(sessionWrite).toBeDefined();
    expect(modelWrite).toBeDefined();
    expect(summaryWrite).toBeDefined();

    // Sessions carry fingerprint + arrayUnion, token counts attributed
    // via FieldValue.increment on the exact token field (pinning the
    // value catches a regression that swaps totalTokens/input/etc.)
    expect(sessionWrite!.data.keyFingerprint).toBe("sk-byot…wxyz");
    expect(sessionWrite!.data.keyFingerprints).toEqual({
      __op: "arrayUnion",
      values: ["sk-byot…wxyz"],
    });
    expect(sessionWrite!.data.gatewayId).toBe("gw-test");
    expect(sessionWrite!.data.workspaceId).toBe("christopher");
    expect(sessionWrite!.data.tokensUsed).toEqual({ __op: "increment", value: 35 });
    expect(sessionWrite!.data.costUsd).toEqual({ __op: "increment", value: 0.01 });
    expect(sessionWrite!.data.interactions).toEqual({ __op: "increment", value: 1 });
    expect(sessionWrite!.data["roles.brain"]).toEqual({ __op: "increment", value: 35 });
    expect(sessionWrite!.data["token_breakdown.input"]).toEqual({ __op: "increment", value: 10 });
    expect(sessionWrite!.data["token_breakdown.output"]).toEqual({ __op: "increment", value: 20 });
    expect(sessionWrite!.data["token_breakdown.cacheRead"]).toEqual({ __op: "increment", value: 5 });

    // Models doc: role/model/fingerprint + pinned tokens/cost
    expect(modelWrite!.data.model).toBe("anthropic/claude-sonnet-4-6");
    expect(modelWrite!.data.role).toBe("brain");
    expect(modelWrite!.data.keyFingerprint).toBe("sk-byot…wxyz");
    expect(modelWrite!.data.workspaceId).toBe("christopher");
    expect(modelWrite!.data.tokens).toEqual({ __op: "increment", value: 35 });
    expect(modelWrite!.data.cost_usd).toEqual({ __op: "increment", value: 0.01 });
    expect(modelWrite!.data.interaction_count).toEqual({ __op: "increment", value: 1 });

    // Summary: lastFingerprint + rolling totals + per-model cost by
    // normalized model key (slash → underscore).
    expect(summaryWrite!.data.lastKeyFingerprint).toBe("sk-byot…wxyz");
    expect(summaryWrite!.data.workspaceId).toBe("christopher");
    expect(summaryWrite!.data.totalTokens).toEqual({ __op: "increment", value: 35 });
    expect(summaryWrite!.data.totalCostUsd).toEqual({ __op: "increment", value: 0.01 });
    expect(summaryWrite!.data.totalInteractions).toEqual({ __op: "increment", value: 1 });
    expect(summaryWrite!.data["modelCosts.anthropic_claude-sonnet-4-6"]).toEqual({
      __op: "increment",
      value: 0.01,
    });
  });

  it("still writes the legacy user-level fields (backward compat)", async () => {
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
      "sk-ant…abcd",
    );

    const today = new Date().toISOString().slice(0, 10);
    const userUpdate = writes.find((w) => w.path === "users/eckert-uid" && w.op === "update");
    const logSet = writes.find((w) => w.path === `users/eckert-uid/usage_logs/${today}`);

    expect(userUpdate).toBeDefined();
    expect(userUpdate!.data["usage.totalTokensUsed"]).toBeDefined();
    expect(logSet).toBeDefined();
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
      new Map(),                        // empty map
      () => {},
      "gw-test",
      "sk-ant…abcd",
    );

    expect(writes).toEqual([]);
  });

  it("skips workspace-scoped writes when customer-config.json has no slug", async () => {
    const { db, writes } = makeStubDb({
      selectedTier: "pro",
      usage: {},
    });
    // Empty config — readWorkspaceId returns null.
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
      "sk-ant…abcd",
    );

    const wsWrites = writes.filter((w) => w.path.startsWith("workspaces/"));
    expect(wsWrites).toEqual([]);

    // But legacy writes still happen.
    const legacyWrites = writes.filter((w) => w.path.startsWith("users/"));
    expect(legacyWrites.length).toBeGreaterThan(0);
  });
});
