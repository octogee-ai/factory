import { describe, expect, it, vi } from "vitest";
import type { GatewayDoc } from "../../shared/types/gateway-releases.js";
import {
  platformOpenAiEmbeddingMemorySearch,
  platformOpenAiEmbeddingSecretId,
} from "../lib/openclaw-config-builders.js";
import {
  planEmbeddingRefRepair,
  repairTargetRevisionAllowed,
  runEmbeddingRefRepair,
} from "../lib/embedding-ref-repair.js";

function coach(id: string, refOwnerId?: string): Record<string, unknown> {
  return {
    id,
    name: `Coach (${id})`,
    ...(refOwnerId !== undefined
      ? { memorySearch: platformOpenAiEmbeddingMemorySearch(refOwnerId) }
      : {}),
  };
}

function config(agents: unknown[]): Record<string, unknown> {
  return {
    agents: { list: agents },
    bindings: [{ agentId: "octogee-alice-coach" }],
    channels: {
      mattermost: { accounts: { "alice-coach": { botToken: "LITERAL-PAT-MUST-SURVIVE" } } },
    },
  };
}

function root(overrides: Partial<GatewayDoc> = {}): GatewayDoc {
  return {
    gatewayId: "default",
    createdAt: 1,
    createdBy: "op",
    updatedAt: 1,
    updatedBy: "op",
    latestRelease: 8,
    desiredRelease: 8,
    liveRelease: 2,
    liveRevisionId: "default-r2",
    trafficRevisionId: "default-r2",
    desiredStatus: "running",
    roll: {
      operationId: "roll-8",
      status: "migrating",
      fromRelease: 2,
      toRelease: 8,
      sourceRevisionId: "default-r2",
      targetRevisionId: "default-r8",
      acceptingNewAssignments: false,
      startedAt: 1,
      updatedAt: 2,
      error: null,
      flippedAt: null,
    },
    ...overrides,
  };
}

describe("planEmbeddingRefRepair", () => {
  it("reports every platform ref not derived from its own agent id, with current and expected ids", () => {
    const plan = planEmbeddingRefRepair(
      config([
        coach("octogee-alice-coach", "octogee-alice-coach"),
        coach("octogee-livefixture-coach", "octogee-tester5-coach"),
        coach("octogee-bob-coach", "octogee-alice-coach"),
        coach("octogee-no-search-coach"),
      ]),
      { agentDirExists: () => true },
    );

    expect(plan.agentsConfigured).toBe(4);
    expect(plan.mismatched).toEqual([
      {
        agentId: "octogee-livefixture-coach",
        currentId: platformOpenAiEmbeddingSecretId("octogee-tester5-coach"),
        expectedId: platformOpenAiEmbeddingSecretId("octogee-livefixture-coach"),
      },
      {
        agentId: "octogee-bob-coach",
        currentId: platformOpenAiEmbeddingSecretId("octogee-alice-coach"),
        expectedId: platformOpenAiEmbeddingSecretId("octogee-bob-coach"),
      },
    ]);
    expect(plan.absentAgentDirs).toEqual([]);
    expect(plan.nextAgentsList).not.toBeNull();
  });

  it("returns a null next list when every ref is already correctly bound", () => {
    const plan = planEmbeddingRefRepair(
      config([coach("octogee-alice-coach", "octogee-alice-coach"), coach("octogee-b-coach")]),
      { agentDirExists: () => true },
    );

    expect(plan.mismatched).toEqual([]);
    expect(plan.nextAgentsList).toBeNull();
  });

  it("flags platform-ref agents whose own agent dir is absent — a rebound ref would still refuse to resolve", () => {
    const plan = planEmbeddingRefRepair(
      config([
        coach("octogee-alice-coach", "octogee-alice-coach"),
        coach("octogee-ghost-coach", "octogee-tester5-coach"),
      ]),
      { agentDirExists: (agentId) => agentId !== "octogee-ghost-coach" },
    );

    expect(plan.absentAgentDirs).toEqual(["octogee-ghost-coach"]);
  });

  it("ignores BYO refs and tolerates a config without an agents list", () => {
    const byo = {
      id: "octogee-alice-coach",
      memorySearch: {
        remote: { apiKey: { source: "exec", provider: "gcp-secret-manager", id: "byo-alice" } },
      },
    };
    expect(planEmbeddingRefRepair(config([byo]), { agentDirExists: () => true }).mismatched).toEqual([]);
    expect(planEmbeddingRefRepair({}, { agentDirExists: () => true })).toEqual({
      agentsConfigured: 0,
      mismatched: [],
      absentAgentDirs: [],
      nextAgentsList: null,
    });
  });
});

describe("repairTargetRevisionAllowed", () => {
  it("allows exactly the live, traffic, and roll-source revisions", () => {
    const gw = root();
    expect(repairTargetRevisionAllowed(gw, "default-r2")).toBe(true);
    expect(
      repairTargetRevisionAllowed(root({ trafficRevisionId: "default-r3" }), "default-r3"),
    ).toBe(true);
  });

  it("refuses the roll target, unreferenced orphans, and desired-only revisions", () => {
    const gw = root();
    expect(repairTargetRevisionAllowed(gw, "default-r8")).toBe(false);
    expect(repairTargetRevisionAllowed(gw, "default-r4")).toBe(false);
    expect(repairTargetRevisionAllowed(gw, "default-r5")).toBe(false);
    expect(
      repairTargetRevisionAllowed(root({ roll: null, desiredRelease: 9 }), "default-r9"),
    ).toBe(false);
  });
});

describe("runEmbeddingRefRepair", () => {
  function corrupted(): Record<string, unknown> {
    return config([
      coach("octogee-alice-coach", "octogee-alice-coach"),
      coach("octogee-livefixture-coach", "octogee-tester5-coach"),
    ]);
  }
  function healedGet(): { config: Record<string, unknown>; hash: string } {
    return {
      hash: "h2",
      config: config([
        coach("octogee-alice-coach", "octogee-alice-coach"),
        coach("octogee-livefixture-coach", "octogee-livefixture-coach"),
      ]),
    };
  }

  it("dry-run reports the plan and never writes", async () => {
    const configApply = vi.fn();
    const result = await runEmbeddingRefRepair({
      rpc: { configGet: vi.fn(async () => ({ config: {}, hash: "h1" })), configApply },
      readUnredactedConfig: async () => corrupted(),
      agentDirExists: () => true,
      dryRun: true,
      log: vi.fn(),
    });

    expect(result.applied).toBe(false);
    expect(result.plan.mismatched).toHaveLength(1);
    expect(configApply).not.toHaveBeenCalled();
  });

  it("apply rewrites ONLY the agents list on the unredacted base config, preserving literal secrets, then verifies via the rpc view", async () => {
    const base = corrupted();
    const configApply = vi.fn(async () => ({ ok: true as const }));
    const configGet = vi
      .fn()
      .mockResolvedValueOnce({ config: {}, hash: "h1" })
      .mockResolvedValueOnce(healedGet());

    const result = await runEmbeddingRefRepair({
      rpc: { configGet, configApply },
      readUnredactedConfig: async () => base,
      agentDirExists: () => true,
      dryRun: false,
      log: vi.fn(),
    });

    expect(result.applied).toBe(true);
    expect(result.verified).toBe(true);
    expect(configApply).toHaveBeenCalledOnce();
    const [appliedConfig, hash] = configApply.mock.calls[0] as [Record<string, unknown>, string];
    expect(hash).toBe("h1");
    expect(
      (appliedConfig.channels as { mattermost: { accounts: Record<string, unknown> } }).mattermost
        .accounts["alice-coach"],
    ).toEqual({ botToken: "LITERAL-PAT-MUST-SURVIVE" });
    const list = (appliedConfig.agents as { list: Array<{ id: string; memorySearch?: { remote?: { apiKey?: { id?: string } } } }> }).list;
    expect(list.find((a) => a.id === "octogee-livefixture-coach")?.memorySearch?.remote?.apiKey?.id).toBe(
      platformOpenAiEmbeddingSecretId("octogee-livefixture-coach"),
    );
    expect(base).toEqual(corrupted());
  });

  it("refuses to apply while any platform-ref agent dir is absent", async () => {
    const configApply = vi.fn();
    await expect(
      runEmbeddingRefRepair({
        rpc: { configGet: vi.fn(async () => ({ config: {}, hash: "h1" })), configApply },
        readUnredactedConfig: async () => corrupted(),
        agentDirExists: (agentId) => agentId !== "octogee-livefixture-coach",
        dryRun: false,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/absent agent dir/u);
    expect(configApply).not.toHaveBeenCalled();
  });

  it("is a no-op on a clean config", async () => {
    const configApply = vi.fn();
    const result = await runEmbeddingRefRepair({
      rpc: { configGet: vi.fn(async () => ({ config: {}, hash: "h1" })), configApply },
      readUnredactedConfig: async () => healedGet().config,
      agentDirExists: () => true,
      dryRun: false,
      log: vi.fn(),
    });

    expect(result.applied).toBe(false);
    expect(result.verified).toBe(true);
    expect(configApply).not.toHaveBeenCalled();
  });

  it("throws when post-apply verification still sees a mismatched ref", async () => {
    const configGet = vi
      .fn()
      .mockResolvedValueOnce({ config: {}, hash: "h1" })
      .mockResolvedValueOnce({ config: corrupted(), hash: "h2" });

    await expect(
      runEmbeddingRefRepair({
        rpc: { configGet, configApply: vi.fn(async () => ({ ok: true as const })) },
        readUnredactedConfig: async () => corrupted(),
        agentDirExists: () => true,
        dryRun: false,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/verification/u);
  });
});
