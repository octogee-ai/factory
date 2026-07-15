import { describe, it, expect, vi } from "vitest";
import { runMigration } from "./fleet-migration-runner";
import type { MigrationClient } from "./fleet-migration-client";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";

const SNAPSHOT: FleetBrokerUserSnapshot = {
  uid: "uid-alice",
  slug: "alice",
  tier: "trial",
  gatewayId: "gw-blue",
  status: "complete",
  agentIds: ["octogee-alice-coach"],
  repoUrl: "git@gitea:octogee/alice.git",
  mattermostUserId: "mm-alice",
  customerMmUserId: "mm-alice",
  greetingPosted: true,
  channels: [],
  projects: [],
  ownerName: "Alice",
  email: "alice@example.com",
  displayName: "Alice",
  lastName: "",
  photoURL: "",
  onboardingVibe: null,
  coachToken: "coach-token",
  coachMmUserId: "mm-coach",
};

function happyClient(): MigrationClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    freezeConfig: vi.fn(async ({ slug }) => {
      calls.push(`config-freeze:${slug}`);
      return {
        migrationId: "m1",
        slug,
        frozen: true,
        checkpointCommit: "a".repeat(40),
        configHash: "b".repeat(64),
      };
    }) as MigrationClient["freezeConfig"],
    proveConfigRestore: vi.fn(async ({ slug, checkpointCommit, transportId, gatewayId }) => {
      calls.push(`config-proof:${slug}:${checkpointCommit}`);
      return {
        migrationId: "m1",
        slug,
        restoredCommit: checkpointCommit,
        acceptedCommit: "c".repeat(40),
        configHash: "d".repeat(64),
        configReady: true,
        observedRevisionId: transportId ?? gatewayId,
        restoreProvenAt: 100,
        configReadyAt: 101,
        runtimeConfigHash: "runtime-after",
      };
    }) as MigrationClient["proveConfigRestore"],
    unfreezeConfig: vi.fn(async ({ slug }) => {
      calls.push(`config-unfreeze:${slug}`);
      return { migrationId: "m1", slug, unfrozen: true };
    }) as MigrationClient["unfreezeConfig"],
    restoreTarget: vi.fn(async ({ slug }) => {
      calls.push(`restore:${slug}`);
      return { migrationId: "m1", slug, restored: true, steps: ["clone-workspace-repo"] };
    }) as MigrationClient["restoreTarget"],
    quiesce: vi.fn(async ({ slug }) => {
      calls.push(`quiesce:${slug}`);
      return { migrationId: "m1", slug, drained: true, runningCount: 0 };
    }) as MigrationClient["quiesce"],
    transferState: vi.fn(async ({ slug, mode }) => {
      calls.push(`transfer:${slug}:${mode ?? "default"}`);
      return { migrationId: "m1", slug, imported: true };
    }) as MigrationClient["transferState"],
    verifyTarget: vi.fn(async ({ slug }) => {
      calls.push(`verify:${slug}`);
      return {
        migrationId: "m1",
        slug,
        ready: true,
        checks: {
          customerDir: true,
          coachWired: true,
          mountMarked: true,
          accountHealthy: true,
        },
      };
    }) as MigrationClient["verifyTarget"],
    unmount: vi.fn(async ({ slug }) => {
      calls.push(`unmount:${slug}`);
      return { migrationId: "m1", slug, unmounted: true };
    }) as MigrationClient["unmount"],
    calls,
  };
}

interface ReportedStep {
  name: string;
  status: "running" | "done" | "failed" | "skipped";
  error?: string;
}

interface CutoverCommitCall {
  uid: string;
  slug: string;
  toGatewayId: string;
  fromGatewayId: string;
  flipMirror: boolean;
  revision: { revisionId: string; release: number } | null;
  rollFence?: {
    configReady?: {
      observedRevisionId: string;
      acceptedCommit: string;
      configReadyAt: number;
      runtimeConfigHash: string;
    };
  };
}

function makeDeps(client: MigrationClient & { calls: string[] }) {
  // Records every atomic cutover commit; a mirror-flipping commit also lands in
  // client.calls so the flow-order assertions still see the cutover step.
  const commitCalls: CutoverCommitCall[] = [];
  // Mirror flips only (flipMirror=true) — the analogue of the old cutoverCalls.
  const cutoverCalls: Array<{ uid: string; toGatewayId: string; slug: string }> = [];
  const logCalls: string[] = [];
  const reportedSteps: ReportedStep[] = [];
  return {
    client,
    commitCutover: vi.fn(async (c: CutoverCommitCall) => {
      commitCalls.push(c);
      if (c.flipMirror) {
        client.calls.push(`cutover:${c.uid}->${c.toGatewayId}`);
        cutoverCalls.push({ uid: c.uid, toGatewayId: c.toGatewayId, slug: c.slug });
      }
    }),
    setAssignmentState: vi.fn(
      async (args: { gatewayId: string; uid: string; state: string }) => {
        client.calls.push(`roster-state:${args.gatewayId}:${args.state}`);
      },
    ),
    log: (msg: string) => logCalls.push(msg),
    reportStep: vi.fn(async (step: ReportedStep) => {
      reportedSteps.push(step);
    }),
    acceptConfigProof: vi.fn(async () => {
      client.calls.push("config-observe");
    }),
    commitCalls,
    cutoverCalls,
    logCalls,
    reportedSteps,
  };
}

const INPUT = {
  migrationId: "m1",
  uid: "uid-alice",
  slug: "alice",
  fromGatewayId: "gw-blue",
  toGatewayId: "gw-green",
  restoreSnapshot: SNAPSHOT,
};

describe("runMigration — happy path", () => {
  it("executes the blue/green flow in order: keys → restore → pre-sync → quiesce → final-sync → verify → cutover → unmount", async () => {
    const client = happyClient();
    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(true);
    expect(res.finalPhase).toBe("done");
    expect(res.rolledBack).toBe(false);
    expect(client.calls).toEqual([
      "transfer:alice:keys",
      "restore:alice",
      "transfer:alice:pre",
      "quiesce:alice",
      "transfer:alice:final",
      "verify:alice",
      "cutover:uid-alice->gw-green",
      "unmount:alice",
    ]);
  });

  it("logs a step-completed line for every step", async () => {
    const client = happyClient();
    const deps = makeDeps(client);
    await runMigration(INPUT, deps);
    expect(deps.logCalls.some((l) => l.includes("keys-sync-state") && l.includes("ok"))).toBe(true);
    expect(deps.logCalls.some((l) => l.includes("quiesce") && l.includes("ok"))).toBe(true);
    expect(deps.logCalls.some((l) => l.includes("pre-sync-state") && l.includes("ok"))).toBe(true);
    expect(deps.logCalls.some((l) => l.includes("final-sync-state") && l.includes("ok"))).toBe(true);
    expect(deps.logCalls.some((l) => l.includes("cutover") && l.includes("ok"))).toBe(true);
    expect(deps.logCalls.some((l) => l.includes("unmount") && l.includes("ok"))).toBe(true);
  });

  it("emits reportStep running→done for each forward step in order", async () => {
    const client = happyClient();
    const deps = makeDeps(client);
    await runMigration(INPUT, deps);
    expect(deps.reportedSteps).toEqual([
      { name: "keys-sync-state", status: "running" },
      { name: "keys-sync-state", status: "done" },
      { name: "restore-target", status: "running" },
      { name: "restore-target", status: "done" },
      { name: "pre-sync-state", status: "running" },
      { name: "pre-sync-state", status: "done" },
      { name: "quiesce-source", status: "running" },
      { name: "quiesce-source", status: "done" },
      { name: "final-sync-state", status: "running" },
      { name: "final-sync-state", status: "done" },
      { name: "verify-target", status: "running" },
      { name: "verify-target", status: "done" },
      { name: "cutover-firestore", status: "running" },
      { name: "cutover-firestore", status: "done" },
      { name: "unmount-source", status: "running" },
      { name: "unmount-source", status: "done" },
    ]);
  });
});

describe("runMigration — durable config roll fence", () => {
  const FENCED_INPUT = {
    ...INPUT,
    fromGatewayId: "default",
    toGatewayId: "default",
    fromTransportId: "default-r1",
    toTransportId: "default-r2",
    fromRevision: { revisionId: "default-r1", release: 1 },
    toRevision: { revisionId: "default-r2", release: 2 },
    crossGateway: false,
    systemConfigMigrationMode: "checkpoint-and-restore" as const,
    rollFence: {
      uid: "uid-alice",
      gatewayId: "default",
      rollOperationId: "roll-1",
      targetRevisionId: "default-r2",
      targetRelease: 2,
      sourceRevisionId: "default-r1",
      sourceEpoch: 1,
    },
  };

  it("keeps the source frozen after assignment cutover until the roll commits the authoritative traffic flip", async () => {
    const client = happyClient();
    const deps = makeDeps(client);

    const result = await runMigration(FENCED_INPUT, deps);

    expect(result).toMatchObject({
      success: true,
      configCheckpoint: {
        checkpointCommit: "a".repeat(40),
        configHash: "b".repeat(64),
      },
      configProof: {
        restoredCommit: "a".repeat(40),
        acceptedCommit: "c".repeat(40),
      },
    });
    expect(client.calls).toEqual([
      "config-freeze:alice",
      "transfer:alice:keys",
      "restore:alice",
      `config-proof:alice:${"a".repeat(40)}`,
      "config-observe",
      "transfer:alice:pre",
      "roster-state:default:quiescing",
      "quiesce:alice",
      "transfer:alice:final",
      "verify:alice",
      "unmount:alice",
    ]);
    expect(deps.reportedSteps).toContainEqual({ name: "freeze-config", status: "done" });
    expect(deps.reportedSteps).toContainEqual({ name: "prove-config-restore", status: "done" });
    expect(client.unfreezeConfig).not.toHaveBeenCalled();
    expect(deps.commitCalls[0].rollFence?.configReady).toEqual({
      observedRevisionId: "default-r2",
      acceptedCommit: "c".repeat(40),
      configReadyAt: 101,
      runtimeConfigHash: "runtime-after",
    });
  });

  it("rejects an edit attempted after assignment cutover because the source remains frozen until traffic flips", async () => {
    const client = happyClient();
    let sourceFrozen = false;
    client.freezeConfig = vi.fn(async ({ migrationId, slug }) => {
      sourceFrozen = true;
      return {
        migrationId,
        slug,
        frozen: true,
        checkpointCommit: "a".repeat(40),
        configHash: "b".repeat(64),
      };
    }) as MigrationClient["freezeConfig"];
    client.unfreezeConfig = vi.fn(async ({ migrationId, slug }) => {
      sourceFrozen = false;
      return { migrationId, slug, unfrozen: true };
    }) as MigrationClient["unfreezeConfig"];
    const deps = makeDeps(client);

    const result = await runMigration(FENCED_INPUT, deps);
    const editAttempt = () => {
      if (sourceFrozen) throw new Error("system config is frozen");
    };

    expect(result.success).toBe(true);
    expect(editAttempt).toThrow("system config is frozen");
    expect(client.unfreezeConfig).not.toHaveBeenCalled();
  });

  it("checkpoints an isolated source without applying its config to a shared target", async () => {
    const client = happyClient();
    const deps = makeDeps(client);

    const result = await runMigration({
      ...INPUT,
      fromRevision: { revisionId: "gw-blue-r1", release: 1 },
      toRevision: { revisionId: "gw-green-r1", release: 1 },
      systemConfigMigrationMode: "checkpoint-only",
    }, deps);

    expect(result.success).toBe(true);
    expect(result.configCheckpoint).toEqual({
      checkpointCommit: "a".repeat(40),
      configHash: "b".repeat(64),
    });
    expect(result.configProof).toBeUndefined();
    expect(client.proveConfigRestore).not.toHaveBeenCalled();
    expect(deps.acceptConfigProof).not.toHaveBeenCalled();
    expect(client.calls.indexOf("cutover:uid-alice->gw-green")).toBeLessThan(
      client.calls.indexOf("config-unfreeze:alice"),
    );
    expect(client.calls.indexOf("config-unfreeze:alice")).toBeLessThan(
      client.calls.indexOf("unmount:alice"),
    );
  });

  it("persists a cleanup obligation instead of completing when cross-gateway unfreeze is unconfirmed", async () => {
    const client = happyClient();
    client.unfreezeConfig = vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      unfrozen: false,
    })) as MigrationClient["unfreezeConfig"];
    const deps = makeDeps(client);

    const result = await runMigration({
      ...INPUT,
      fromTransportId: "gw-blue-r1",
      toTransportId: "gw-green-r1",
      fromRevision: { revisionId: "gw-blue-r1", release: 1 },
      toRevision: { revisionId: "gw-green-r1", release: 1 },
      systemConfigMigrationMode: "checkpoint-only",
    }, deps);

    expect(result).toMatchObject({
      success: false,
      finalPhase: "cutover-done",
      rolledBack: false,
      errorAt: { error: expect.stringMatching(/config unfreeze cleanup pending/i) },
      configCleanup: {
        migrationId: "m1",
        slug: "alice",
        sourceGatewayId: "gw-blue",
        sourceTransportId: "gw-blue-r1",
        resume: { success: true, rolledBack: false },
      },
    });
    expect(client.unmount).not.toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "gw-blue",
    }));
  });

  it("blocks cutover and unfreezes the source when target ancestor proof fails", async () => {
    const client = happyClient();
    client.proveConfigRestore = vi.fn(async () => {
      throw new Error("target history does not contain source checkpoint");
    }) as MigrationClient["proveConfigRestore"];
    const deps = makeDeps(client);

    const result = await runMigration(FENCED_INPUT, deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.errorAt?.error).toMatch(/does not contain source checkpoint/);
    expect(deps.commitCutover).not.toHaveBeenCalled();
    expect(client.unfreezeConfig).toHaveBeenCalledWith(expect.objectContaining({
      transportId: "default-r1",
    }));
  });

  it("persists a cleanup obligation when rollback succeeds but source unfreeze does not", async () => {
    const client = happyClient();
    client.proveConfigRestore = vi.fn(async () => {
      throw new Error("target history does not contain source checkpoint");
    }) as MigrationClient["proveConfigRestore"];
    client.unfreezeConfig = vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      unfrozen: false,
    })) as MigrationClient["unfreezeConfig"];
    const deps = makeDeps(client);

    const result = await runMigration(FENCED_INPUT, deps);

    expect(result).toMatchObject({
      success: false,
      rolledBack: true,
      errorAt: { error: expect.stringMatching(/config unfreeze cleanup pending/i) },
      configCleanup: {
        sourceGatewayId: "default",
        sourceTransportId: "default-r1",
        resume: {
          success: false,
          rolledBack: true,
          error: "target history does not contain source checkpoint",
        },
      },
    });
  });

  it("blocks cutover when Cowboy cannot persist the revision-observed proof", async () => {
    const client = happyClient();
    const deps = makeDeps(client);
    deps.acceptConfigProof = vi.fn(async () => {
      throw new Error("revision status write unavailable");
    });

    const result = await runMigration(FENCED_INPUT, deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.errorAt?.error).toMatch(/status write unavailable/);
    expect(deps.commitCutover).not.toHaveBeenCalled();
  });

  it("blocks every transfer when the source cannot push its checkpoint", async () => {
    const client = happyClient();
    client.freezeConfig = vi.fn(async () => {
      throw new Error("config checkpoint push pending");
    }) as MigrationClient["freezeConfig"];
    const deps = makeDeps(client);

    const result = await runMigration(FENCED_INPUT, deps);

    expect(result).toMatchObject({ success: false, finalPhase: "initial", rolledBack: false });
    expect(client.transferState).not.toHaveBeenCalled();
    expect(deps.commitCutover).not.toHaveBeenCalled();
  });
});

describe("runMigration — cutover is ONE atomic commit (P0)", () => {
  it("same-gateway drain: one commit with the assignment and NO mirror flip; unmount comes AFTER", async () => {
    const order: string[] = [];
    const client = happyClient();
    client.unmount = vi.fn(async ({ slug }) => {
      order.push("unmount");
      return { migrationId: "m1", slug, unmounted: true };
    }) as MigrationClient["unmount"];
    const deps = makeDeps(client);
    deps.commitCutover = vi.fn(async (c: CutoverCommitCall) => {
      order.push("commit");
      deps.commitCalls.push(c);
    });

    const res = await runMigration(
      {
        ...INPUT,
        fromGatewayId: "default",
        toGatewayId: "default",
        fromTransportId: "default-r1",
        toTransportId: "default-r2",
        toRevision: { revisionId: "default-r2", release: 2 },
        crossGateway: false,
      },
      deps,
    );

    expect(res.success).toBe(true);
    expect(deps.commitCalls).toHaveLength(1);
    expect(deps.commitCalls[0]).toMatchObject({
      uid: "uid-alice",
      toGatewayId: "default",
      flipMirror: false, // mirror stays bare
      revision: { revisionId: "default-r2", release: 2 },
    });
    expect(order).toEqual(["commit", "unmount"]);
  });

  it("cross-pool forward cutover: one commit flips the mirror AND writes the target revision", async () => {
    const deps = makeDeps(happyClient());
    const res = await runMigration(
      { ...INPUT, toRevision: { revisionId: "gw-green-r1", release: 1 }, fromRevision: { revisionId: "gw-blue-r1", release: 1 } },
      deps,
    );
    expect(res.success).toBe(true);
    expect(deps.commitCalls).toHaveLength(1);
    expect(deps.commitCalls[0]).toMatchObject({
      toGatewayId: "gw-green",
      fromGatewayId: "gw-blue",
      flipMirror: true,
      revision: { revisionId: "gw-green-r1" },
    });
  });

  it("cross-gateway source cleanup failure preserves the verified target assignment", async () => {
    const client = happyClient();
    let firstUnmount = true;
    client.unmount = vi.fn(async ({ slug, gatewayId }) => {
      if (firstUnmount && gatewayId === "gw-blue") {
        firstUnmount = false;
        throw new Error("unmount-source failed");
      }
      return { migrationId: "m1", slug, unmounted: true };
    }) as MigrationClient["unmount"];
    const deps = makeDeps(client);

    const res = await runMigration(
      { ...INPUT, toRevision: { revisionId: "gw-green-r1", release: 1 }, fromRevision: { revisionId: "gw-blue-r1", release: 1 } },
      deps,
    );

    expect(res).toMatchObject({ success: true, rolledBack: false, finalPhase: "done" });
    expect(
      deps.commitCalls.map((c) => ({ to: c.toGatewayId, flip: c.flipMirror, rev: c.revision?.revisionId })),
    ).toEqual([
      { to: "gw-green", flip: true, rev: "gw-green-r1" },
    ]);
  });
});

describe("runMigration — failures", () => {
  it("cleans up the pre-synced target when quiesce fails — source still owns", async () => {
    const client = happyClient();
    client.quiesce = vi.fn(async () => {
      throw new Error("quiesce did not drain: 2 still running");
    }) as MigrationClient["quiesce"];

    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(false);
    expect(res.errorAt?.phase).toBe("pre-synced");
    expect(res.errorAt?.error).toMatch(/did not drain/);
    expect(res.rolledBack).toBe(true);
    expect(deps.commitCutover).not.toHaveBeenCalled();
    expect(client.unmount).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: "gw-green", slug: "alice" }),
    );
  });

  it("cleans up the target import when final sync fails (source-quiesced phase)", async () => {
    const client = happyClient();
    let transferCount = 0;
    client.transferState = vi.fn(async ({ migrationId, slug }) => {
      transferCount++;
      if (transferCount === 3) throw new Error("export: 503 upstream draining");
      return { migrationId, slug, imported: true };
    }) as MigrationClient["transferState"];

    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(false);
    expect(res.errorAt?.phase).toBe("source-quiesced");
    expect(res.rolledBack).toBe(true);

    expect(deps.commitCutover).not.toHaveBeenCalled();
    expect(client.unmount).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: "gw-green", slug: "alice" }),
    );

const failed = deps.reportedSteps.find((s) => s.status === "failed");
    expect(failed?.name).toBe("final-sync-state");
    expect(failed?.error).toMatch(/503/);
    const rollbackNames = deps.reportedSteps
      .filter((s) => s.name.startsWith("rollback:"))
      .map((s) => s.name);
    expect(rollbackNames).toContain("rollback:unmount-target");
  });

  it("keeps the durable target cutover when post-cutover source cleanup fails", async () => {
    const client = happyClient();
    client.unmount = vi.fn(async () => {
      throw new Error("unmount: 500 config.patch failed");
    }) as MigrationClient["unmount"];

    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res).toMatchObject({
      success: true,
      finalPhase: "done",
      rolledBack: false,
    });
    expect(deps.cutoverCalls).toHaveLength(1);
    expect(deps.cutoverCalls[0]).toMatchObject({
      uid: "uid-alice",
      toGatewayId: "gw-green",
      slug: "alice",
    });
    expect(deps.reportedSteps).toContainEqual({
      name: "unmount-source",
      status: "skipped",
      error: "unmount: 500 config.patch failed",
    });
    expect(deps.logCalls.some((line) => line.includes("cleanup failed after durable cutover"))).toBe(true);
  });

  it("does NOT roll back when the rollback would itself destroy data (post source-unmounted)", async () => {

const client = happyClient();
    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(true);
    expect(res.rolledBack).toBe(false);
  });

  it("treats a rollback step that itself fails as a logged warning, not a thrown error (operator-runbook situation)", async () => {
    const client = happyClient();
    let transferCount = 0;
    client.transferState = vi.fn(async ({ migrationId, slug }) => {
      transferCount++;
      if (transferCount === 3) throw new Error("export: 503");
      return { migrationId, slug, imported: true };
    }) as MigrationClient["transferState"];
    client.unmount = vi.fn(async () => {
      throw new Error("rollback target cleanup failed: 500");
    }) as MigrationClient["unmount"];

    const deps = makeDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(
      deps.logCalls.some(
        (l) => l.includes("rollback") && l.toLowerCase().includes("warn"),
      ),
    ).toBe(true);
  });
});

describe("runMigration — gated quiesce (revision drains, PR7)", () => {
  const DRAIN_INPUT = {
    ...INPUT,
    fromGatewayId: "default",
    toGatewayId: "default",
    fromTransportId: "default-r1",
    toTransportId: "default-r2",
    fromRevision: { revisionId: "default-r1", release: 1 },
    toRevision: { revisionId: "default-r2", release: 2 },
    crossGateway: false,
  };

  const drainDeps = makeDeps;

  it("marks the assignment quiescing BEFORE the source quiesce RPC — source serving is blocked before the target ever serves", async () => {
    const client = happyClient();
    const deps = drainDeps(client);
    const res = await runMigration(DRAIN_INPUT, deps);
    expect(res.success).toBe(true);
    const quiesceMark = client.calls.indexOf("roster-state:default:quiescing");
    const quiesceRpc = client.calls.indexOf("quiesce:alice");
    expect(quiesceMark).toBeGreaterThanOrEqual(0);
    expect(quiesceRpc).toBeGreaterThan(quiesceMark);
  });

  it("quiesce failure FAILS the migration (roll holds): rollback runs, no cutover commit, assignment restored to serving", async () => {
    const client = happyClient();
    client.quiesce = vi.fn(async () => {
      throw new Error("quiesce did not drain: 2 still running");
    }) as MigrationClient["quiesce"];
    const deps = drainDeps(client);

    const res = await runMigration(DRAIN_INPUT, deps);

    expect(res.success).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(deps.commitCutover).not.toHaveBeenCalled();
    // The quiescing mark is reverted so the customer keeps serving on source.
    expect(client.calls).toContain("roster-state:default:serving");
    expect(client.calls.indexOf("roster-state:default:serving")).toBeGreaterThan(
      client.calls.indexOf("roster-state:default:quiescing"),
    );
  });

  it("a post-quiesce pre-cutover failure (final sync) also restores the assignment to serving on rollback", async () => {
    const client = happyClient();
    let transferCount = 0;
    client.transferState = vi.fn(async ({ migrationId, slug }) => {
      transferCount++;
      if (transferCount === 3) throw new Error("export: 503 upstream draining");
      return { migrationId, slug, imported: true };
    }) as MigrationClient["transferState"];
    const deps = drainDeps(client);

    const res = await runMigration(DRAIN_INPUT, deps);

    expect(res.success).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(deps.commitCutover).not.toHaveBeenCalled();
    expect(client.calls).toContain("roster-state:default:serving");
  });

  it("keeps the target revision serving when source cleanup fails after same-gateway cutover", async () => {
    const client = happyClient();
    client.unmount = vi.fn(async ({ slug, gatewayId }) => {
      // First unmount call is unmount-source on the drain (same bare gateway).
      if ((client.unmount as ReturnType<typeof vi.fn>).mock.calls.length === 1) {
        throw new Error("unmount-source failed");
      }
      return { migrationId: "m1", slug: slug ?? "alice", unmounted: true, gatewayId };
    }) as MigrationClient["unmount"];
    const deps = drainDeps(client);

    const res = await runMigration(DRAIN_INPUT, deps);

    expect(res.success).toBe(true);
    expect(res.rolledBack).toBe(false);
    expect(deps.commitCalls.map((c) => c.revision?.revisionId)).toEqual([
      "default-r2",
    ]);
    expect(client.calls).not.toContain("roster-state:default:serving");
    expect(deps.reportedSteps).toContainEqual(
      expect.objectContaining({ name: "unmount-source", status: "skipped" }),
    );
  });

  it("legacy migration (no fromRevision): no roster-state writes at all", async () => {
    const client = happyClient();
    const deps = drainDeps(client);
    const res = await runMigration(INPUT, deps);
    expect(res.success).toBe(true);
    expect(client.calls.filter((c) => c.startsWith("roster-state:"))).toEqual([]);
  });

  it("does not report cleanup failure as a migration failure after a verified drain cutover", async () => {
    const client = happyClient();
    let first = true;
    client.unmount = vi.fn(async ({ slug }) => {
      if (first) {
        first = false;
        throw new Error("rate limit exceeded for config.patch; retry after 16s");
      }
      return { migrationId: "m1", slug, unmounted: true };
    }) as MigrationClient["unmount"];
    const deps = drainDeps(client);

    const res = await runMigration(DRAIN_INPUT, deps);

    expect(res.success).toBe(true);
    expect(res.rolledBack).toBe(false);
    expect(deps.reportedSteps).toContainEqual(
      expect.objectContaining({ name: "unmount-source", status: "skipped" }),
    );
  });
});
