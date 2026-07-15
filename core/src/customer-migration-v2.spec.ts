import { describe, expect, it, vi } from "vitest";
import { MigrationRpcError, type MigrationClient } from "./fleet-migration-client.js";
import {
  advanceCustomerMigrationV2,
  beginCustomerMigrationV2Abort,
  classifyCustomerMigrationV2Error,
  isCustomerMigrationV2PostIntent,
  isCustomerMigrationV2Transition,
  type CustomerMigrationV2Deps,
} from "./customer-migration-v2.js";
import type { CustomerMigrationV2State } from "@octogee/shared/types/glm";
import type { ConfigCandidateProofResponse } from "@octogee/shared/types/fleet-controller";

const CHECKPOINT = "a".repeat(40);
const FREEZE_OBJECT = "b".repeat(40);
const CANDIDATE = "c".repeat(40);
const HASH = "d".repeat(64);

function state(
  phase: CustomerMigrationV2State["phase"] = "initialized",
): CustomerMigrationV2State {
  return {
    phase,
    operationId: "op-1",
    migrationId: "mig-op-1",
    uid: "uid-1",
    slug: "alice",
    sourceGatewayId: "source",
    sourceRevisionId: "source-r1",
    sourceRelease: 1,
    sourceEpoch: 7,
    targetGatewayId: "target",
    targetRevisionId: "target-r3",
    targetRelease: 3,
    sourceImageTag: "source-image",
    sourceBuildSha: "source-build",
    sourceOpenclawVersion: "2026.7.1",
    targetImageTag: "target-image",
  };
}

function proof(): ConfigCandidateProofResponse {
  return {
    migrationId: "mig-op-1",
    slug: "alice",
    sourceRevisionId: "source-r1",
    targetRevisionId: "target-r3",
    checkpointCommit: CHECKPOINT,
    candidateCommit: CANDIDATE,
    candidateHash: HASH,
    candidateRef: "refs/octogee/system-config/candidate/target-r3",
    freezeObject: FREEZE_OBJECT,
    runtimeConfigHash: HASH,
    observedRevisionId: "target-r3",
    targetStartedAt: 123,
    imageTag: "target-image",
    buildSha: "target-build",
    openclawVersion: "2026.7.2",
    configReady: true,
    provenAt: 456,
  };
}

function deps(): CustomerMigrationV2Deps {
  const client = {
    freezeConfig: vi.fn(),
    proveConfigRestore: vi.fn(),
    reproveConfigRestore: vi.fn(),
    unfreezeConfig: vi.fn(),
    freezeConfigV2: vi.fn(async () => ({
      migrationId: "mig-op-1",
      slug: "alice",
      sourceRevisionId: "source-r1",
      targetRevisionId: "target-r3",
      frozen: true as const,
      checkpointCommit: CHECKPOINT,
      configHash: HASH,
      freezeRef: "refs/octogee/system-config/freeze/source-r1",
      freezeObject: FREEZE_OBJECT,
    })),
    proveConfigCandidate: vi.fn(async () => proof()),
    promoteConfigCandidate: vi.fn(async () => ({
      migrationId: "mig-op-1",
      slug: "alice",
      sourceRevisionId: "source-r1",
      targetRevisionId: "target-r3",
      promoted: true as const,
      promotedCommit: CANDIDATE,
    })),
    abortConfigV2: vi.fn(async () => ({
      migrationId: "mig-op-1",
      slug: "alice",
      sourceRevisionId: "source-r1",
      targetRevisionId: "target-r3",
      aborted: true as const,
    })),
    finalizeConfigV2: vi.fn(async () => ({
      migrationId: "mig-op-1",
      slug: "alice",
      sourceRevisionId: "source-r1",
      targetRevisionId: "target-r3",
      finalized: true as const,
    })),
    transferState: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", imported: true })),
    restoreTarget: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", restored: true })),
    quiesce: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", drained: true, runningCount: 0 })),
    verifyTarget: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", ready: true })),
    unmount: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", unmounted: true })),
    flushGateway: vi.fn(),
  } as unknown as MigrationClient;
  return {
    client,
    restoreSnapshot: { uid: "uid-1" } as never,
    installTargetContext: vi.fn(async () => undefined),
    clearTargetContext: vi.fn(async () => undefined),
    assertCandidateProofCurrent: vi.fn(async () => undefined),
    setSourceAssignmentState: vi.fn(async () => undefined),
    commitCutover: vi.fn(async () => undefined),
    now: vi.fn(() => 1_000),
  };
}

describe("advanceCustomerMigrationV2", () => {
  it("drives the exact restart-durable V2 protocol and never calls legacy config RPCs", async () => {
    const d = deps();
    let current = state();
    const phases: string[] = [];
    while (current.phase !== "complete") {
      current = await advanceCustomerMigrationV2(current, d);
      phases.push(current.phase);
    }

    expect(phases).toEqual([
      "checkpointed", "targetPrepared", "keysSynced", "targetRestored",
      "candidateProven", "preSynced", "sourceQuiesced", "finalSynced",
      "targetVerified", "promotionIntent", "promoted", "cutover",
      "sourceRetired", "finalized", "complete",
    ]);
    expect(d.client.freezeConfig).not.toHaveBeenCalled();
    expect(d.client.proveConfigRestore).not.toHaveBeenCalled();
    expect(d.client.unfreezeConfig).not.toHaveBeenCalled();
    expect(d.commitCutover).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "op-1",
      migrationId: "mig-op-1",
      candidateCommit: CANDIDATE,
    }));
  });

  it("reissues an RPC after response loss because state advances only after the response", async () => {
    const d = deps();
    vi.mocked(d.client.freezeConfigV2)
      .mockRejectedValueOnce(new Error("response lost"));
    const initial = state();

    await expect(advanceCustomerMigrationV2(initial, d)).rejects.toThrow("response lost");
    const advanced = await advanceCustomerMigrationV2(initial, d);

    expect(advanced.phase).toBe("checkpointed");
    expect(d.client.freezeConfigV2).toHaveBeenCalledTimes(2);
  });

  it("fails the restore phase explicitly when its phase-scoped snapshot was not loaded", async () => {
    const d = deps();
    d.restoreSnapshot = undefined;
    const current = {
      ...state("keysSynced"),
      checkpointCommit: CHECKPOINT,
      configHash: HASH,
      freezeRef: "refs/octogee/system-config/freeze/source-r1",
      freezeObject: FREEZE_OBJECT,
    };

    await expect(advanceCustomerMigrationV2(current, d)).rejects.toThrow(
      /restore phase lacks its durable snapshot/i,
    );
    expect(d.client.restoreTarget).not.toHaveBeenCalled();
  });

  it("re-proves immediately before persisting promotion intent", async () => {
    const d = deps();
    const proven = proof();
    const current = {
      ...state("targetVerified"),
      checkpointCommit: CHECKPOINT,
      configHash: HASH,
      freezeRef: "refs/octogee/system-config/freeze/source-r1",
      freezeObject: FREEZE_OBJECT,
      candidateProof: proven,
    };

    const advanced = await advanceCustomerMigrationV2(current, d);

    expect(advanced.phase).toBe("promotionIntent");
    expect(d.client.proveConfigCandidate).toHaveBeenCalledOnce();
    expect(d.assertCandidateProofCurrent).toHaveBeenCalledWith(proven);
  });

  it("does not persist stale target proof after a target restart", async () => {
    const d = deps();
    vi.mocked(d.assertCandidateProofCurrent).mockRejectedValueOnce(
      new Error("target restarted after candidate proof"),
    );
    const current = {
      ...state("targetRestored"),
      checkpointCommit: CHECKPOINT,
      configHash: HASH,
      freezeRef: "refs/octogee/system-config/freeze/source-r1",
      freezeObject: FREEZE_OBJECT,
    };

    await expect(advanceCustomerMigrationV2(current, d)).rejects.toThrow("target restarted");
    expect(current.phase).toBe("targetRestored");
  });

  it("re-proves a promoted candidate after a target restart before cutover", async () => {
    const d = deps();
    const refreshed = { ...proof(), targetStartedAt: 999, provenAt: 1_001 };
    vi.mocked(d.assertCandidateProofCurrent)
      .mockRejectedValueOnce(new Error("target restarted"))
      .mockResolvedValue(undefined);
    vi.mocked(d.client.proveConfigCandidate).mockResolvedValue(refreshed);
    const promoted = {
      ...state("promoted"),
      checkpointCommit: CHECKPOINT,
      configHash: HASH,
      freezeRef: "refs/octogee/system-config/freeze/source-r1",
      freezeObject: FREEZE_OBJECT,
      candidateProof: proof(),
      promotionIntentAt: 900,
      promotedAt: 950,
    };

    const reproven = await advanceCustomerMigrationV2(promoted, d);
    const cutover = await advanceCustomerMigrationV2(reproven, d);

    expect(reproven).toMatchObject({ phase: "promoted", candidateProof: refreshed });
    expect(cutover.phase).toBe("cutover");
    expect(d.commitCutover).toHaveBeenCalledWith(expect.objectContaining({
      targetStartedAt: 999,
      provenAt: 1_001,
    }));
  });

  it("resumes from every persisted phase after a controller crash", async () => {
    const snapshots: CustomerMigrationV2State[] = [];
    let current = state();
    while (current.phase !== "complete") {
      snapshots.push(current);
      current = await advanceCustomerMigrationV2(current, deps());
    }

    for (const snapshot of snapshots) {
      const d = deps();
      let resumed = snapshot;
      while (resumed.phase !== "complete") {
        resumed = await advanceCustomerMigrationV2(resumed, d);
      }
      expect(resumed.phase).toBe("complete");
      expect(d.client.freezeConfig).not.toHaveBeenCalled();
      expect(d.client.proveConfigRestore).not.toHaveBeenCalled();
      expect(d.client.unfreezeConfig).not.toHaveBeenCalled();
    }
  });

  it("retries every RPC edge safely after the response is lost", async () => {
    const snapshots = new Map<CustomerMigrationV2State["phase"], CustomerMigrationV2State>();
    let current = state();
    while (current.phase !== "complete") {
      snapshots.set(current.phase, current);
      current = await advanceCustomerMigrationV2(current, deps());
    }
    const phases = [
      "initialized", "checkpointed", "targetPrepared", "keysSynced", "targetRestored",
      "candidateProven", "preSynced", "sourceQuiesced", "finalSynced", "targetVerified",
      "promotionIntent", "promoted", "cutover", "sourceRetired", "finalized",
    ] as const;

    for (const phase of phases) {
      const snapshot = snapshots.get(phase)!;
      const d = deps();
      const failing = (() => {
        switch (phase) {
          case "initialized": return d.client.freezeConfigV2;
          case "checkpointed": return d.installTargetContext;
          case "targetPrepared":
          case "candidateProven":
          case "sourceQuiesced": return d.client.transferState;
          case "keysSynced": return d.client.restoreTarget;
          case "targetRestored":
          case "targetVerified": return d.client.proveConfigCandidate;
          case "preSynced": return d.client.quiesce;
          case "finalSynced": return d.client.verifyTarget;
          case "promotionIntent": return d.client.promoteConfigCandidate;
          case "promoted": return d.commitCutover;
          case "cutover": return d.client.unmount;
          case "sourceRetired": return d.client.finalizeConfigV2;
          case "finalized": return d.clearTargetContext;
        }
      })();
      vi.mocked(failing).mockRejectedValueOnce(new Error(`lost ${phase} response`));

      await expect(advanceCustomerMigrationV2(snapshot, d)).rejects.toThrow("response");
      const advanced = await advanceCustomerMigrationV2(snapshot, d);

      expect(advanced.phase).not.toBe(phase);
      expect(failing).toHaveBeenCalledTimes(2);
    }
  });

  it("recovers a lost abort response and completes the durable pre-intent cleanup", async () => {
    const d = deps();
    vi.mocked(d.client.abortConfigV2).mockRejectedValueOnce(new Error("abort response lost"));
    let current = beginCustomerMigrationV2Abort({
      ...state("checkpointed"),
      checkpointCommit: CHECKPOINT,
      configHash: HASH,
      freezeRef: "refs/octogee/system-config/freeze/source-r1",
      freezeObject: FREEZE_OBJECT,
    }, "superseded", 10);

    await expect(advanceCustomerMigrationV2(current, d)).rejects.toThrow("response lost");
    while (current.phase !== "aborted") {
      current = await advanceCustomerMigrationV2(current, d);
    }

    expect(d.client.abortConfigV2).toHaveBeenCalledTimes(2);
    expect(d.clearTargetContext).toHaveBeenCalledOnce();
    expect(d.setSourceAssignmentState).toHaveBeenLastCalledWith("serving");
  });
});

describe("customer migration V2 failure boundary", () => {
  it("classifies terminal protocol conflicts separately from retryable loss/unavailability", () => {
    expect(classifyCustomerMigrationV2Error(
      new MigrationRpcError("conflict", { status: 409, code: "config-ref-conflict" }),
    )).toBe("terminal");
    expect(classifyCustomerMigrationV2Error(
      new MigrationRpcError("busy", { status: 503, code: "config-writer-lock-busy" }),
    )).toBe("retry");
    expect(classifyCustomerMigrationV2Error(new Error("socket response lost"))).toBe("retry");
    for (const error of [
      new TypeError("fetch failed"),
      new Error("terminated"),
      new Error("premature close"),
      new SyntaxError("Unexpected end of JSON input"),
      Object.assign(new Error("14 UNAVAILABLE: upstream reset"), { code: 14 }),
      Object.assign(new Error("request aborted"), { name: "AbortError" }),
    ]) {
      expect(classifyCustomerMigrationV2Error(error), error.message).toBe("retry");
    }
    expect(classifyCustomerMigrationV2Error(new Error("malformed config response binding"))).toBe("terminal");
  });

  it("persists abort intent before the irreversible boundary and never aborts after it", () => {
    const pre = beginCustomerMigrationV2Abort(state("targetVerified"), "superseded", 12);
    expect(pre).toMatchObject({
      phase: "abortIntent",
      abortFromPhase: "targetVerified",
      abortReason: "superseded",
    });
    expect(isCustomerMigrationV2PostIntent(pre)).toBe(false);
    expect(() => beginCustomerMigrationV2Abort(
      state("promotionIntent"),
      "superseded",
      12,
    )).toThrow("roll forward");
    expect(isCustomerMigrationV2PostIntent(state("promoted"))).toBe(true);
  });

  it("accepts only the next durable phase or the legal pre-intent abort branch", () => {
    expect(isCustomerMigrationV2Transition("checkpointed", "targetPrepared")).toBe(true);
    expect(isCustomerMigrationV2Transition("targetVerified", "abortIntent")).toBe(true);
    expect(isCustomerMigrationV2Transition("promotionIntent", "abortIntent")).toBe(false);
    expect(isCustomerMigrationV2Transition("checkpointed", "promoted")).toBe(false);
    expect(isCustomerMigrationV2Transition("promoted", "promoted")).toBe(true);
  });
});
