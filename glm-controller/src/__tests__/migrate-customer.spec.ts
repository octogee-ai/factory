import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import { createMigrateCustomerHandler } from "../handlers/migrate-customer";
import type { MigrateCustomerDeps } from "../handlers/migrate-customer";
import type { OperationContext } from "../operation-router";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import { MigrationRpcError } from "@octogee/core/fleet-migration-client";
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

function mkOp(overrides: Partial<Operation>): Operation {
  return {
    id: "op-1",
    kind: "migrate-customer",
    status: "pending",
    createdBy: "admin@octogee.com",
    createdAt: 1_000,
    startedAt: null,
    completedAt: null,
    input: { uid: "uid-alice", toGatewayId: "gw-green" },
    steps: [],
    ...overrides,
  };
}

function happyClient(): MigrationClient {
  return {
    freezeConfig: vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      frozen: true,
      checkpointCommit: "a".repeat(40),
      configHash: "b".repeat(64),
    })) as MigrationClient["freezeConfig"],
    proveConfigRestore: vi.fn(async ({ migrationId, slug, checkpointCommit, transportId, gatewayId }) => ({
      migrationId,
      slug,
      restoredCommit: checkpointCommit,
      acceptedCommit: "c".repeat(40),
      configHash: "d".repeat(64),
      configReady: true,
      observedRevisionId: transportId ?? gatewayId,
      restoreProvenAt: 100,
      configReadyAt: 101,
      runtimeConfigHash: "runtime-after",
    })) as MigrationClient["proveConfigRestore"],
    reproveConfigRestore: vi.fn(async () => {
      throw new Error("not used by migration handler");
    }) as MigrationClient["reproveConfigRestore"],
    unfreezeConfig: vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      unfrozen: true,
    })) as MigrationClient["unfreezeConfig"],
    freezeConfigV2: vi.fn(async ({ migrationId, slug, sourceRevisionId, targetRevisionId }) => ({
      migrationId,
      slug,
      sourceRevisionId,
      targetRevisionId,
      frozen: true,
      checkpointCommit: "1".repeat(40),
      configHash: "2".repeat(64),
      freezeRef: `refs/octogee/system-config/freeze/${sourceRevisionId}`,
      freezeObject: "3".repeat(40),
    })) as MigrationClient["freezeConfigV2"],
    proveConfigCandidate: vi.fn(async ({
      migrationId,
      slug,
      sourceRevisionId,
      targetRevisionId,
      checkpointCommit,
      freezeObject,
    }) => ({
      migrationId,
      slug,
      sourceRevisionId,
      targetRevisionId,
      checkpointCommit,
      candidateCommit: "4".repeat(40),
      candidateHash: "5".repeat(64),
      candidateRef: `refs/octogee/system-config/candidate/${targetRevisionId}`,
      freezeObject,
      runtimeConfigHash: "6".repeat(64),
      observedRevisionId: targetRevisionId,
      targetStartedAt: 4_500,
      imageTag: "target-image",
      buildSha: "target-build",
      openclawVersion: "2026.7.2",
      configReady: true,
      provenAt: 4_900,
    })) as MigrationClient["proveConfigCandidate"],
    promoteConfigCandidate: vi.fn(async ({
      migrationId,
      slug,
      sourceRevisionId,
      targetRevisionId,
      candidateCommit,
    }) => ({
      migrationId,
      slug,
      sourceRevisionId,
      targetRevisionId,
      promoted: true,
      promotedCommit: candidateCommit,
    })) as MigrationClient["promoteConfigCandidate"],
    abortConfigV2: vi.fn(async ({ migrationId, slug, sourceRevisionId, targetRevisionId }) => ({
      migrationId,
      slug,
      sourceRevisionId,
      targetRevisionId,
      aborted: true,
    })) as MigrationClient["abortConfigV2"],
    finalizeConfigV2: vi.fn(async ({ migrationId, slug, sourceRevisionId, targetRevisionId }) => ({
      migrationId,
      slug,
      sourceRevisionId,
      targetRevisionId,
      finalized: true,
    })) as MigrationClient["finalizeConfigV2"],
    restoreTarget: vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      restored: true,
      steps: ["clone-workspace-repo"],
    })) as MigrationClient["restoreTarget"],
    quiesce: vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      drained: true,
      runningCount: 0,
    })) as MigrationClient["quiesce"],
    transferState: vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      imported: true,
    })) as MigrationClient["transferState"],
    verifyTarget: vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      ready: true,
      checks: {
        customerDir: true,
        coachWired: true,
        mountMarked: true,
        accountHealthy: true,
      },
    })) as MigrationClient["verifyTarget"],
    unmount: vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      unmounted: true,
    })) as MigrationClient["unmount"],
  };
}

function makeDeps(
  overrides: Partial<MigrateCustomerDeps> = {},
  client: MigrationClient = happyClient(),
): { deps: MigrateCustomerDeps; client: MigrationClient } {
  const deps: MigrateCustomerDeps = {
    readUser: vi.fn(async (_uid: string) => ({
      slug: "alice",
      currentGatewayId: "gw-blue",
    })),
    readUserSnapshot: vi.fn(async () => SNAPSHOT),
    commitCutover: vi.fn(async () => undefined),
    setAssignmentState: vi.fn(async () => undefined),
    assertRollFence: vi.fn(async () => undefined),
    recordConfigProof: vi.fn(async () => undefined),
    recordConfigRollMetric: vi.fn(),
    resolveSystemConfigMigrationMode: vi.fn(async () => "none"),
    assertSystemConfigProtocolReady: vi.fn(async () => undefined),
    readRevisionExecutionIdentity: vi.fn(async (revisionId: string) => ({
      revisionId,
      imageTag: revisionId === "gw-green-r1" ? "target-image" : "source-image",
      buildSha: revisionId === "gw-green-r1" ? "target-build" : "source-build",
      openclawVersion: revisionId === "gw-green-r1" ? "2026.7.2" : "2026.7.1",
      startedAt: revisionId === "gw-green-r1" ? 4_500 : 4_000,
    })),
    installTargetSystemConfigContext: vi.fn(async () => undefined),
    clearTargetSystemConfigContext: vi.fn(async () => undefined),
    assertCandidateProofCurrent: vi.fn(async () => undefined),
    commitV2Cutover: vi.fn(async () => undefined),
    recoverConfigFreezeOwner: vi.fn(async () => false),
    resolveFromRevision: vi.fn(async (_uid: string, gatewayId: string) => ({
      revisionId: `${gatewayId}-r1`,
      release: 1,
      epoch: 1,
    })),
    resolvePlacement: vi.fn(async (gatewayId: string) => ({
      ok: true as const,
      revisionId: `${gatewayId}-r1`,
      release: 1,
    })),
    resolveGatewayUrl: vi.fn(async (gw: string) => `http://test/${gw}`),
    buildClient: vi.fn((_resolveSync: (gw: string) => string) => client),
    genMigrationId: () => "mig-test-1",
    now: () => 5_000,
    log: vi.fn((_msg: string) => undefined),
    ...overrides,
  };
  return { deps, client };
}

function makeCtx(): OperationContext & { reported: OperationStep[] } {
  const reported: OperationStep[] = [];
  const persistedV2: NonNullable<Operation["customerMigrationV2"]>[] = [];
  return {
    reportStep: vi.fn(async (step: OperationStep) => {
      reported.push(step);
    }),
    persistCustomerMigrationV2: vi.fn(async (state) => {
      persistedV2.push(state);
    }),
    cancellationRequested: vi.fn(async () => false),
    reported,
    persistedV2,
  };
}

function durableV2State(
  phase: NonNullable<Operation["customerMigrationV2"]>["phase"],
): NonNullable<Operation["customerMigrationV2"]> {
  return {
    phase,
    operationId: "op-1",
    migrationId: "mig-test-1",
    uid: "uid-alice",
    slug: "alice",
    sourceGatewayId: "gw-blue",
    sourceRevisionId: "gw-blue-r1",
    sourceRelease: 1,
    sourceEpoch: 1,
    sourceAssignmentMode: "assigned",
    targetGatewayId: "gw-green",
    targetRevisionId: "gw-green-r1",
    targetRelease: 1,
    sourceImageTag: "source-image",
    sourceBuildSha: "source-build",
    sourceOpenclawVersion: "2026.7.1",
    targetImageTag: "target-image",
    checkpointCommit: "1".repeat(40),
    configHash: "2".repeat(64),
    freezeRef: "refs/octogee/system-config/freeze/gw-blue-r1",
    freezeObject: "3".repeat(40),
  };
}

describe("createMigrateCustomerHandler — ordinary isolated protocol V2", () => {
  it("retries raw source transport failure before checkpoint without aborting or terminalizing", async () => {
    const client = happyClient();
    vi.mocked(client.freezeConfigV2).mockRejectedValueOnce(new TypeError("fetch failed"));
    const { deps } = makeDeps({
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-and-restore"),
    }, client);

    const result = await createMigrateCustomerHandler(deps)(mkOp({}), makeCtx());

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.error).toMatch(/V2 retry pending.*fetch failed/i);
    expect(client.abortConfigV2).not.toHaveBeenCalled();
  });

  it("retries setup outages after checkpoint and leaves the durable source freeze intact", async () => {
    const client = happyClient();
    const { deps } = makeDeps({
      readUserSnapshot: vi.fn(async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      }),
    }, client);
    const op = mkOp({ customerMigrationV2: durableV2State("checkpointed") });

    const result = await createMigrateCustomerHandler(deps)(op, makeCtx());

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.error).toMatch(/V2 retry pending.*Unexpected end/i);
    expect(client.abortConfigV2).not.toHaveBeenCalled();
    expect(client.freezeConfigV2).not.toHaveBeenCalled();
  });

  it("resumes from durable identity without re-reading a deleted user after checkpoint", async () => {
    const readUser = vi.fn(async () => {
      throw new Error("user document was deleted");
    });
    const { deps } = makeDeps({ readUser });

    const result = await createMigrateCustomerHandler(deps)(
      mkOp({ customerMigrationV2: durableV2State("checkpointed") }),
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(readUser).not.toHaveBeenCalled();
  });

  it("durably aborts when the restore snapshot is terminally unavailable at the restore phase", async () => {
    const client = happyClient();
    const { deps } = makeDeps({
      readUserSnapshot: vi.fn(async () => null),
    }, client);
    const ctx = makeCtx();

    const result = await createMigrateCustomerHandler(deps)(
      mkOp({ customerMigrationV2: durableV2State("keysSynced") }),
      ctx,
    );

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(ctx.persistedV2.map((entry) => entry.phase)).toEqual([
      "abortIntent",
      "abortPublished",
      "abortTargetUnmounted",
      "abortContextCleared",
      "aborted",
    ]);
    expect(client.abortConfigV2).toHaveBeenCalledOnce();
    expect(client.restoreTarget).not.toHaveBeenCalled();
  });

  it("persists abort progress when a target URL disappears after source quiesce", async () => {
    const resolveGatewayUrl = vi.fn(async (revisionId: string) => {
      if (revisionId === "gw-green-r1") throw new Error("target revision was deleted");
      return `http://test/${revisionId}`;
    });
    const { deps, client } = makeDeps({ resolveGatewayUrl });
    const ctx = makeCtx();

    const result = await createMigrateCustomerHandler(deps)(
      mkOp({ customerMigrationV2: durableV2State("sourceQuiesced") }),
      ctx,
    );

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.error).toMatch(/retry pending.*abort cleanup blocked.*target revision was deleted/i);
    expect(ctx.persistedV2.map((entry) => entry.phase)).toEqual(["abortIntent", "abortPublished"]);
    expect(client.abortConfigV2).toHaveBeenCalledOnce();
  });

  it("routes a terminal cancellation-read failure through durable pre-intent abort", async () => {
    const { deps, client } = makeDeps();
    const ctx = makeCtx();
    ctx.cancellationRequested = vi.fn(async () => {
      throw new Error("cancellation record is corrupt");
    });

    const result = await createMigrateCustomerHandler(deps)(
      mkOp({ customerMigrationV2: durableV2State("checkpointed") }),
      ctx,
    );

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(ctx.persistedV2.map((entry) => entry.phase)).toContain("abortIntent");
    expect(ctx.persistedV2.at(-1)?.phase).toBe("aborted");
    expect(client.abortConfigV2).toHaveBeenCalledOnce();
  });

  it("does not require the mutable user document while resuming from durable scope", async () => {
    const client = happyClient();
    const readUser = vi.fn(async () => {
      throw Object.assign(new Error("14 UNAVAILABLE: Firestore read failed"), { code: 14 });
    });
    const { deps } = makeDeps({
      readUser,
    }, client);

    const result = await createMigrateCustomerHandler(deps)(
      mkOp({ customerMigrationV2: durableV2State("checkpointed") }),
      makeCtx(),
    );

    expect(result.success).toBe(true);
    expect(readUser).not.toHaveBeenCalled();
    expect(client.abortConfigV2).not.toHaveBeenCalled();
  });

  it("keeps abort cleanup retryable through a raw source outage", async () => {
    const client = happyClient();
    vi.mocked(client.abortConfigV2).mockRejectedValueOnce(new TypeError("fetch failed"));
    const { deps } = makeDeps({}, client);

    const result = await createMigrateCustomerHandler(deps)(
      mkOp({ customerMigrationV2: {
        ...durableV2State("abortIntent"),
        abortFromPhase: "checkpointed",
        abortReason: "candidate conflict",
        abortIntentAt: 4_999,
      } }),
      makeCtx(),
    );

    expect(result.error).toMatch(/V2 retry pending.*fetch failed/i);
    expect(result.rolledBack).toBe(false);
  });

  it("keeps abort cleanup retryable through a terminal source URL error", async () => {
    const readUserSnapshot = vi.fn(async () => {
      throw new Error("snapshot must not be read during abort");
    });
    const { deps, client } = makeDeps({
      readUserSnapshot,
      resolveGatewayUrl: vi.fn(async (revisionId: string) => {
        if (revisionId === "gw-blue-r1") throw new Error("source revision was deleted");
        return `http://test/${revisionId}`;
      }),
    });
    const ctx = makeCtx();

    const result = await createMigrateCustomerHandler(deps)(
      mkOp({ customerMigrationV2: {
        ...durableV2State("abortIntent"),
        abortFromPhase: "checkpointed",
        abortReason: "candidate conflict",
        abortIntentAt: 4_999,
      } }),
      ctx,
    );

    expect(result.error).toMatch(/retry pending.*abort cleanup blocked.*source revision was deleted/i);
    expect(result.rolledBack).toBe(false);
    expect(ctx.persistedV2).toEqual([]);
    expect(readUserSnapshot).not.toHaveBeenCalled();
    expect(client.abortConfigV2).not.toHaveBeenCalled();
  });

  it.each([
    ["complete", true, false],
    ["aborted", false, true],
  ] as const)("finishes a durably persisted %s phase without re-running setup", async (
    phase,
    success,
    rolledBack,
  ) => {
    const { deps } = makeDeps({
      readUser: vi.fn(async () => { throw new Error("setup must not run"); }),
      readUserSnapshot: vi.fn(async () => { throw new Error("setup must not run"); }),
      resolveGatewayUrl: vi.fn(async () => { throw new Error("setup must not run"); }),
    });
    const terminal = durableV2State(phase);
    if (phase === "aborted") terminal.abortReason = "candidate conflict";

    const result = await createMigrateCustomerHandler(deps)(
      mkOp({ customerMigrationV2: terminal }),
      makeCtx(),
    );

    expect(result).toMatchObject({ success, rolledBack });
    expect(deps.readUser).not.toHaveBeenCalled();
    expect(deps.readUserSnapshot).not.toHaveBeenCalled();
    expect(deps.resolveGatewayUrl).not.toHaveBeenCalled();
  });

  it("uses only V2 config control and durably persists every migration edge", async () => {
    const { deps, client } = makeDeps({
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-and-restore"),
    });
    const ctx = makeCtx();

    const result = await createMigrateCustomerHandler(deps)(mkOp({}), ctx);

    expect(result.success).toBe(true);
    expect(client.freezeConfigV2).toHaveBeenCalledOnce();
    expect(client.proveConfigCandidate).toHaveBeenCalledTimes(2);
    expect(client.promoteConfigCandidate).toHaveBeenCalledOnce();
    expect(client.finalizeConfigV2).toHaveBeenCalledOnce();
    expect(client.freezeConfig).not.toHaveBeenCalled();
    expect(client.proveConfigRestore).not.toHaveBeenCalled();
    expect(client.unfreezeConfig).not.toHaveBeenCalled();
    expect(ctx.persistedV2.map((entry) => entry.phase)).toEqual([
      "initialized", "checkpointed", "targetPrepared", "keysSynced", "targetRestored",
      "candidateProven", "preSynced", "sourceQuiesced", "finalSynced",
      "targetVerified", "promotionIntent", "promoted", "cutover", "sourceRetired",
      "finalized", "complete",
    ]);
    expect(deps.commitV2Cutover).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "op-1",
      sourceRevisionId: "gw-blue-r1",
      targetRevisionId: "gw-green-r1",
    }));
  });

  it("carries an unassigned live root binding through quiesce and atomic cutover", async () => {
    const { deps } = makeDeps({
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-and-restore"),
      resolveFromRevision: vi.fn(async () => ({
        revisionId: "gw-blue-r1",
        release: 1,
        assignmentMode: "unassigned-live",
        rootUpdatedAt: 17,
      })),
    });
    const ctx = makeCtx();

    const result = await createMigrateCustomerHandler(deps)(mkOp({}), ctx);

    expect(result.success).toBe(true);
    expect(ctx.persistedV2[0]).toMatchObject({
      sourceAssignmentMode: "unassigned-live",
      sourceRootUpdatedAt: 17,
      sourceEpoch: 0,
    });
    expect(deps.setAssignmentState).toHaveBeenCalledWith({
      gatewayId: "gw-blue",
      uid: "uid-alice",
      slug: "alice",
      revisionId: "gw-blue-r1",
      release: 1,
      epoch: 0,
      state: "quiescing",
      updatedByOperationId: "op-1",
      createIfMissing: true,
    });
    expect(deps.commitV2Cutover).toHaveBeenCalledWith(expect.objectContaining({
      sourceAssignmentMode: "unassigned-live",
      sourceRootUpdatedAt: 17,
      sourceRelease: 1,
    }));
  });

  it("rechecks exact placement before freeze and refuses a root generation race", async () => {
    const resolveFromRevision = vi
      .fn()
      .mockResolvedValueOnce({
        revisionId: "gw-blue-r1",
        release: 1,
        assignmentMode: "unassigned-live",
        rootUpdatedAt: 17,
      })
      .mockResolvedValueOnce({
        revisionId: "gw-blue-r1",
        release: 1,
        assignmentMode: "unassigned-live",
        rootUpdatedAt: 18,
      });
    const { deps, client } = makeDeps({
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-and-restore"),
      resolveFromRevision,
    });
    const ctx = makeCtx();

    const result = await createMigrateCustomerHandler(deps)(mkOp({}), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.error).toMatch(/source placement changed before freeze/i);
    expect(ctx.persistedV2.map((entry) => entry.phase)).toEqual(["initialized"]);
    expect(client.freezeConfigV2).not.toHaveBeenCalled();
    expect(client.abortConfigV2).not.toHaveBeenCalled();
  });

  it("resumes from the durable phase without reacquiring the source lease", async () => {
    const { deps, client } = makeDeps({
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-and-restore"),
    });
    const op = mkOp({
      customerMigrationV2: {
        phase: "promotionIntent",
        operationId: "op-1",
        migrationId: "mig-test-1",
        uid: "uid-alice",
        slug: "alice",
        sourceGatewayId: "gw-blue",
        sourceRevisionId: "gw-blue-r1",
        sourceRelease: 1,
        sourceEpoch: 1,
        targetGatewayId: "gw-green",
        targetRevisionId: "gw-green-r1",
        targetRelease: 1,
        sourceImageTag: "source-image",
        sourceBuildSha: "source-build",
        sourceOpenclawVersion: "2026.7.1",
        targetImageTag: "target-image",
        checkpointCommit: "1".repeat(40),
        configHash: "2".repeat(64),
        freezeRef: "refs/octogee/system-config/freeze/gw-blue-r1",
        freezeObject: "3".repeat(40),
        candidateProof: await client.proveConfigCandidate({
          migrationId: "mig-test-1",
          gatewayId: "gw-green",
          slug: "alice",
          sourceRevisionId: "gw-blue-r1",
          targetRevisionId: "gw-green-r1",
          checkpointCommit: "1".repeat(40),
          freezeObject: "3".repeat(40),
        }),
        promotionIntentAt: 4_999,
      },
    });
    vi.mocked(client.proveConfigCandidate).mockClear();

    const result = await createMigrateCustomerHandler(deps)(op, makeCtx());

    expect(result.success).toBe(true);
    expect(client.freezeConfigV2).not.toHaveBeenCalled();
    expect(client.proveConfigCandidate).not.toHaveBeenCalled();
    expect(client.promoteConfigCandidate).toHaveBeenCalledOnce();
  });

  it("durably aborts a terminal pre-intent 409 and restores source service", async () => {
    const { deps, client } = makeDeps({
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-and-restore"),
    });
    vi.mocked(client.proveConfigCandidate).mockRejectedValueOnce(
      new MigrationRpcError("candidate conflict", { status: 409, code: "config-ref-conflict" }),
    );
    const ctx = makeCtx();

    const result = await createMigrateCustomerHandler(deps)(mkOp({}), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: true, error: "candidate conflict" });
    expect(ctx.persistedV2.map((entry) => entry.phase)).toContain("abortIntent");
    expect(ctx.persistedV2.at(-1)?.phase).toBe("aborted");
    expect(client.abortConfigV2).toHaveBeenCalledOnce();
    expect(deps.setAssignmentState).toHaveBeenLastCalledWith(expect.objectContaining({
      gatewayId: "gw-blue",
      state: "serving",
    }));
  });

  it("never aborts after promotion intent even when promotion returns a terminal conflict", async () => {
    const { deps, client } = makeDeps({
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-and-restore"),
    });
    const candidateProof = await client.proveConfigCandidate({
      migrationId: "mig-test-1",
      gatewayId: "gw-green",
      slug: "alice",
      sourceRevisionId: "gw-blue-r1",
      targetRevisionId: "gw-green-r1",
      checkpointCommit: "1".repeat(40),
      freezeObject: "3".repeat(40),
    });
    vi.mocked(client.proveConfigCandidate).mockClear();
    vi.mocked(client.promoteConfigCandidate).mockRejectedValueOnce(
      new MigrationRpcError("main moved", { status: 409, code: "config-ref-conflict" }),
    );
    const op = mkOp({
      customerMigrationV2: {
        phase: "promotionIntent",
        operationId: "op-1",
        migrationId: "mig-test-1",
        uid: "uid-alice",
        slug: "alice",
        sourceGatewayId: "gw-blue",
        sourceRevisionId: "gw-blue-r1",
        sourceRelease: 1,
        sourceEpoch: 1,
        targetGatewayId: "gw-green",
        targetRevisionId: "gw-green-r1",
        targetRelease: 1,
        sourceImageTag: "source-image",
        sourceBuildSha: "source-build",
        sourceOpenclawVersion: "2026.7.1",
        targetImageTag: "target-image",
        checkpointCommit: "1".repeat(40),
        configHash: "2".repeat(64),
        freezeRef: "refs/octogee/system-config/freeze/gw-blue-r1",
        freezeObject: "3".repeat(40),
        candidateProof,
        promotionIntentAt: 4_999,
      },
    });

    const result = await createMigrateCustomerHandler(deps)(op, makeCtx());

    expect(result).toMatchObject({
      success: false,
      rolledBack: false,
      error: expect.stringMatching(/retry pending.*roll-forward blocked.*main moved/i),
    });
    expect(client.abortConfigV2).not.toHaveBeenCalled();
  });

  it.each(["promotionIntent", "promoted"] as const)(
    "keeps %s roll-forward durable when the target URL disappears",
    async (phase) => {
      const { deps, client } = makeDeps({
        resolveGatewayUrl: vi.fn(async (revisionId: string) => {
          if (revisionId === "gw-green-r1") throw new Error("target revision was deleted");
          return `http://test/${revisionId}`;
        }),
      });
      const candidateProof = await client.proveConfigCandidate({
        migrationId: "mig-test-1",
        gatewayId: "gw-green",
        slug: "alice",
        sourceRevisionId: "gw-blue-r1",
        targetRevisionId: "gw-green-r1",
        checkpointCommit: "1".repeat(40),
        freezeObject: "3".repeat(40),
      });
      const state = {
        ...durableV2State(phase),
        candidateProof,
        promotionIntentAt: 4_999,
        ...(phase === "promoted" ? { promotedAt: 5_000 } : {}),
      };
      const ctx = makeCtx();

      const result = await createMigrateCustomerHandler(deps)(
        mkOp({ customerMigrationV2: state }),
        ctx,
      );

      expect(result).toMatchObject({ success: false, rolledBack: false });
      expect(result.error).toMatch(/retry pending.*roll-forward blocked.*target revision was deleted/i);
      expect(ctx.persistedV2).toEqual([]);
      expect(client.abortConfigV2).not.toHaveBeenCalled();
    },
  );

  it("rejects a stale declared source before persisting or freezing V2 state", async () => {
    const { deps, client } = makeDeps({
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-and-restore"),
    });
    const ctx = makeCtx();

    const result = await createMigrateCustomerHandler(deps)(
      mkOp({ input: {
        uid: "uid-alice",
        fromGatewayId: "gw-stale",
        toGatewayId: "gw-green",
      } }),
      ctx,
    );

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.error).toMatch(/declared source gw-stale.*resolved source gw-blue/i);
    expect(ctx.persistedV2).toEqual([]);
    expect(client.freezeConfigV2).not.toHaveBeenCalled();
  });
});

describe("createMigrateCustomerHandler — happy path", () => {
  it("derives a stable migration id from the durable operation id across retries", async () => {
    const client = happyClient();
    const genMigrationId = vi.fn((operationId: string) => `mig-${operationId}`);
    const { deps } = makeDeps({ genMigrationId }, client);
    const handler = createMigrateCustomerHandler(deps);
    const op = mkOp({ id: "operation-stable" });

    await handler(op, makeCtx());
    await handler(op, makeCtx());

    expect(genMigrationId).toHaveBeenNthCalledWith(1, "operation-stable");
    expect(genMigrationId).toHaveBeenNthCalledWith(2, "operation-stable");
    const ids = (client.transferState as ReturnType<typeof vi.fn>).mock.calls.map(
      ([input]) => input.migrationId,
    );
    expect(new Set(ids)).toEqual(new Set(["mig-operation-stable"]));
  });

  it("resumes only the durable source-unfreeze cleanup before completing a migrated operation", async () => {
    const client = happyClient();
    const { deps } = makeDeps({}, client);
    const handler = createMigrateCustomerHandler(deps);
    const configCleanup = {
      migrationId: "mig-op-1",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceTransportId: "gw-blue-r1",
      resume: {
        success: true,
        rolledBack: false,
        configCheckpoint: {
          checkpointCommit: "a".repeat(40),
          configHash: "b".repeat(64),
        },
      },
    };

    const result = await handler(mkOp({ output: { configCleanup } }), makeCtx());

    expect(result).toEqual({
      steps: [],
      success: true,
      rolledBack: false,
      output: { configCheckpoint: configCleanup.resume.configCheckpoint },
    });
    expect(deps.resolveGatewayUrl).toHaveBeenCalledWith("gw-blue-r1");
    expect(client.unfreezeConfig).toHaveBeenCalledWith({
      migrationId: "mig-op-1",
      gatewayId: "gw-blue",
      transportId: "gw-blue-r1",
      slug: "alice",
    });
    expect(client.transferState).not.toHaveBeenCalled();
    expect(deps.commitCutover).not.toHaveBeenCalled();
  });

  it("keeps the cleanup obligation when a cleanup-only retry still cannot confirm unfreeze", async () => {
    const client = happyClient();
    client.unfreezeConfig = vi.fn(async () => {
      throw new Error("source RPC unavailable");
    }) as MigrationClient["unfreezeConfig"];
    const { deps } = makeDeps({}, client);
    const handler = createMigrateCustomerHandler(deps);
    const configCleanup = {
      migrationId: "mig-op-1",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceTransportId: "gw-blue-r1",
      resume: { success: true, rolledBack: false },
    };

    const result = await handler(mkOp({ output: { configCleanup } }), makeCtx());

    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/config unfreeze cleanup pending.*source RPC unavailable/i),
      output: { configCleanup },
    });
    expect(client.transferState).not.toHaveBeenCalled();
  });

  it("terminalizes a definitive unsupported cleanup instead of retrying forever", async () => {
    const client = happyClient();
    client.unfreezeConfig = vi.fn(async () => {
      throw new MigrationRpcError("/config-unfreeze/gw-blue: 501 not configured", {
        status: 501,
      });
    }) as MigrationClient["unfreezeConfig"];
    const { deps } = makeDeps({}, client);
    const handler = createMigrateCustomerHandler(deps);
    const configCleanup = {
      migrationId: "mig-op-1",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceTransportId: "gw-blue-r1",
      completeSourceUnmount: false,
      resume: { success: true, rolledBack: false },
    };

    const result = await handler(mkOp({ output: { configCleanup } }), makeCtx());

    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/config cleanup terminal.*501/i),
      output: { configCleanup },
    });
  });

  it("retains the deferred source unmount obligation when its cleanup RPC is transiently unavailable", async () => {
    const client = happyClient();
    client.unmount = vi.fn(async () => {
      throw new Error("source RPC unavailable");
    }) as MigrationClient["unmount"];
    const { deps } = makeDeps({}, client);
    const handler = createMigrateCustomerHandler(deps);
    const configCleanup = {
      migrationId: "mig-op-1",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceTransportId: "gw-blue-r1",
      completeSourceUnmount: true,
      resume: { success: true, rolledBack: false },
    };

    const result = await handler(mkOp({ output: { configCleanup } }), makeCtx());

    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/source unmount cleanup pending/i),
      output: { configCleanup },
    });
    expect(client.unfreezeConfig).toHaveBeenCalledOnce();
    expect(client.unmount).toHaveBeenCalledOnce();
  });

  it("fails closed instead of replaying migration when a durable cleanup obligation is malformed", async () => {
    const { deps, client } = makeDeps();
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({
      output: { configCleanup: { migrationId: "mig-op-1" } },
    }), makeCtx());

    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/invalid durable config cleanup obligation/i),
    });
    expect(client.transferState).not.toHaveBeenCalled();
    expect(deps.commitCutover).not.toHaveBeenCalled();
  });

  it("returns success=true and writes all migration step pairs through ctx.reportStep", async () => {
    const { deps } = makeDeps();
    const handler = createMigrateCustomerHandler(deps);
    const ctx = makeCtx();

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.rolledBack).toBe(false);

    const reported = ctx.reported;
    const names = reported.map((s) => `${s.name}:${s.status}`);
    expect(names).toEqual([
      "keys-sync-state:running",
      "keys-sync-state:done",
      "restore-target:running",
      "restore-target:done",
      "pre-sync-state:running",
      "pre-sync-state:done",
      "quiesce-source:running",
      "quiesce-source:done",
      "final-sync-state:running",
      "final-sync-state:done",
      "verify-target:running",
      "verify-target:done",
      "cutover-firestore:running",
      "cutover-firestore:done",
      "unmount-source:running",
      "unmount-source:done",
    ]);
  });

  it("cuts over directly after verify-target during blue/green migration because the public router is stable", async () => {
    const calls: string[] = [];
    const client = happyClient();
    client.verifyTarget = vi.fn(async (input) => {
      calls.push("verify-target");
      return {
        migrationId: input.migrationId,
        slug: input.slug,
        ready: true,
        checks: {
          customerDir: true,
          coachWired: true,
          mountMarked: true,
          accountHealthy: true,
        },
      };
    }) as MigrationClient["verifyTarget"];
    const { deps } = makeDeps(
      {
        commitCutover: vi.fn(async (commit) => {
          calls.push(`cutover:${commit.toGatewayId}`);
        }),
      },
      client,
    );
    const handler = createMigrateCustomerHandler(deps);
    const ctx = makeCtx();

    const result = await handler(
      mkOp({ input: {
        uid: "uid-alice",
        toGatewayId: "gw-green",
        source: "release-roll",
        rollOperationId: "roll-1",
      } }),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(calls).toEqual(["verify-target", "cutover:gw-green"]);
    expect(ctx.reported.map((s) => `${s.name}:${s.status}`)).not.toContain("route-target:running");
  });

  it("looks up the user's slug + current gatewayId from readUser, not from op.input", async () => {
    const readUser = vi.fn(async (_uid: string) => ({
      slug: "alice-from-firestore",
      currentGatewayId: "gw-blue-from-firestore",
    }));
    const { deps, client } = makeDeps({ readUser });
    const handler = createMigrateCustomerHandler(deps);

    await handler(mkOp({ input: { uid: "uid-alice", toGatewayId: "gw-green" } }), makeCtx());

    expect(readUser).toHaveBeenCalledWith("uid-alice");
    expect(client.quiesce).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "alice-from-firestore" }),
    );
  });

  it("commits the cutover with the resolved uid, target gateway, user slug, and a cross-gateway mirror flip", async () => {
    const { deps } = makeDeps();
    const handler = createMigrateCustomerHandler(deps);
    await handler(mkOp({ input: { uid: "uid-alice", toGatewayId: "gw-green" } }), makeCtx());

    expect(deps.commitCutover).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: "uid-alice",
        toGatewayId: "gw-green",
        fromGatewayId: "gw-blue",
        slug: "alice",
        flipMirror: true, // cross-gateway
      }),
    );
  });

  it("pre-resolves both gateway URLs via deps.resolveGatewayUrl before building the client", async () => {
    const resolveGatewayUrl = vi.fn(async (gw: string) => `http://test/${gw}`);
    const { deps } = makeDeps({ resolveGatewayUrl });
    const handler = createMigrateCustomerHandler(deps);
    await handler(mkOp({ input: { uid: "uid-alice", toGatewayId: "gw-green" } }), makeCtx());

    expect(resolveGatewayUrl).toHaveBeenCalledWith("gw-blue-r1");
    expect(resolveGatewayUrl).toHaveBeenCalledWith("gw-green-r1");
    expect(deps.buildClient).toHaveBeenCalledTimes(1);
  });

  // Blue/green + builder-move is class-agnostic now (all gateways are emptyDir
  // Spot cattle): the customer's coach activation manifest must always ride to
  // the target, operator included — the old `sourceImageProfile !== "operator"`
  // skip left the coach half-provisioned (inert) on the new pod.
  it("always requests the activation manifest, regardless of source gateway class", async () => {
    const { deps, client } = makeDeps();
    const handler = createMigrateCustomerHandler(deps);
    await handler(mkOp({}), makeCtx());

    expect(client.transferState).toHaveBeenCalledWith(
      expect.objectContaining({ includeActivationManifest: true }),
    );
    expect(client.transferState).not.toHaveBeenCalledWith(
      expect.objectContaining({ includeActivationManifest: false }),
    );
    expect(client.transferState).toHaveBeenCalledTimes(3);
  });

  it("buildClient's resolver throws on an unexpected gatewayId — no silent default", async () => {
    let capturedResolver: ((gw: string) => string) | null = null;
    const buildClient = vi.fn((resolveSync: (gw: string) => string) => {
      capturedResolver = resolveSync;
      return happyClient();
    });
    const { deps } = makeDeps({ buildClient });
    const handler = createMigrateCustomerHandler(deps);
    await handler(mkOp({}), makeCtx());

    expect(capturedResolver).not.toBeNull();
    const resolver = capturedResolver as unknown as (gw: string) => string;
    expect(() => resolver("gw-unknown")).toThrow(/unexpected gatewayId/);
  });

  it("propagates resolveGatewayUrl errors as handler failure (does NOT silently route to a default)", async () => {
    const resolveGatewayUrl = vi.fn(async (gw: string) => {
      throw new Error(`gateway not registered in glmGateways: ${gw}`);
    });
    const { deps, client } = makeDeps({ resolveGatewayUrl });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(mkOp({}), makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not registered in glmGateways/);
    expect(client.quiesce).not.toHaveBeenCalled();
  });

  it("stamps startedAt on running steps and completedAt on done steps", async () => {
    let tick = 1_000;
    const { deps } = makeDeps({ now: () => tick++ });
    const handler = createMigrateCustomerHandler(deps);
    const ctx = makeCtx();
    await handler(mkOp({}), ctx);

    const running = ctx.reported.filter((s) => s.status === "running");
    const done = ctx.reported.filter((s) => s.status === "done");
    running.forEach((s) => expect(typeof s.startedAt).toBe("number"));
    done.forEach((s) => expect(typeof s.completedAt).toBe("number"));
  });
});

describe("createMigrateCustomerHandler — input validation", () => {
  it("returns failure with explicit error when op.input is missing uid", async () => {
    const { deps } = makeDeps();
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(
      mkOp({ input: { toGatewayId: "gw-green" } }),
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/uid/);
  });

  it("returns failure with explicit error when op.input is missing toGatewayId", async () => {
    const { deps } = makeDeps();
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(mkOp({ input: { uid: "uid-alice" } }), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/toGatewayId/);
  });

  it("returns failure when the user doc does not exist", async () => {
    const readUser = vi.fn(async (_uid: string) => null);
    const { deps } = makeDeps({ readUser });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(mkOp({}), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/user/i);
  });

  it("returns failure when target gateway equals current gateway (already mounted there)", async () => {
    const readUser = vi.fn(async (_uid: string) => ({
      slug: "alice",
      currentGatewayId: "gw-green",
    }));
    const { deps, client } = makeDeps({ readUser });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(
      mkOp({ input: { uid: "uid-alice", toGatewayId: "gw-green" } }),
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already/i);
    expect(client.quiesce).not.toHaveBeenCalled();
  });
});

describe("createMigrateCustomerHandler — revision-targeted (same-gateway drain)", () => {
  it("uses the release roll checkpoint lease instead of reacquiring or releasing the source fence", async () => {
    const { deps, client } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "bender" })),
      resolveFromRevision: vi.fn(async () => ({ revisionId: "bender-r1", release: 1 })),
      resolvePlacement: vi.fn(async () => ({ ok: true as const, revisionId: "bender-r2", release: 2 })),
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-and-restore"),
    });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({ input: {
      uid: "uid-alice",
      builderSlug: "alice",
      toGatewayId: "bender",
      source: "release-roll",
      rollOperationId: "roll-1",
      systemConfigMigrationMode: "checkpoint-and-restore",
      preAcquiredConfigCheckpoint: {
        migrationId: "roll-config-roll-1",
        checkpointCommit: "1".repeat(40),
        configHash: "a".repeat(64),
      },
    } }), makeCtx());

    expect(result.success).toBe(true);
    expect(client.freezeConfig).not.toHaveBeenCalled();
    expect(client.unfreezeConfig).not.toHaveBeenCalled();
    expect(client.proveConfigRestore).toHaveBeenCalledWith(expect.objectContaining({
      migrationId: "roll-config-roll-1",
      checkpointCommit: "1".repeat(40),
    }));
    expect(deps.recordConfigProof).toHaveBeenCalledWith(
      "bender-r2",
      expect.objectContaining({ migrationId: "roll-config-roll-1" }),
      expect.objectContaining({ rollOperationId: "roll-1" }),
    );
  });

  it("rejects a malformed pre-acquired roll checkpoint before source transfer", async () => {
    const { deps, client } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "bender" })),
      resolveFromRevision: vi.fn(async () => ({ revisionId: "bender-r1", release: 1 })),
      resolvePlacement: vi.fn(async () => ({ ok: true as const, revisionId: "bender-r2", release: 2 })),
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-and-restore"),
    });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({ input: {
      uid: "uid-alice",
      toGatewayId: "bender",
      source: "release-roll",
      rollOperationId: "roll-1",
      systemConfigMigrationMode: "checkpoint-and-restore",
      preAcquiredConfigCheckpoint: {
        migrationId: "roll-config-roll-1",
        checkpointCommit: "not-a-commit",
        configHash: "a".repeat(64),
      },
    } }), makeCtx());

    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/invalid preAcquiredConfigCheckpoint/),
    });
    expect(client.freezeConfig).not.toHaveBeenCalled();
    expect(client.transferState).not.toHaveBeenCalled();
  });

  it("leaves gateway-bound config to the protocol-v2 controller during a release drain", async () => {
    const { deps, client } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "bender" })),
      resolveFromRevision: vi.fn(async () => ({ revisionId: "bender-r1", release: 1 })),
      resolvePlacement: vi.fn(async () => ({ ok: true as const, revisionId: "bender-r2", release: 2 })),
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-and-restore"),
    });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({ input: {
      uid: "uid-alice",
      toGatewayId: "bender",
      source: "release-roll",
      rollOperationId: "roll-1",
    } }), makeCtx());

    expect(result.success).toBe(true);
    expect(client.freezeConfig).not.toHaveBeenCalled();
    expect(client.proveConfigRestore).not.toHaveBeenCalled();
  });

  it("checkpoints an idle isolated gateway return without restoring config on the shared target", async () => {
    const { deps, client } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "bender" })),
      resolveFromRevision: vi.fn(async () => ({ revisionId: "bender-r1", release: 1 })),
      resolvePlacement: vi.fn(async () => ({
        ok: true as const,
        revisionId: "default-r3",
        release: 3,
      })),
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-only"),
    });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({ input: {
      uid: "uid-alice",
      toGatewayId: "default",
      source: "dedicated-idle-return",
      systemConfigMigrationMode: "checkpoint-only",
    } }), makeCtx());

    expect(result).toMatchObject({
      success: true,
      output: {
        configCheckpoint: {
          checkpointCommit: "a".repeat(40),
          configHash: "b".repeat(64),
        },
      },
    });
    expect(result.output).not.toHaveProperty("configProof");
    expect(client.freezeConfig).toHaveBeenCalledOnce();
    expect(client.proveConfigRestore).not.toHaveBeenCalled();
    expect(deps.recordConfigProof).not.toHaveBeenCalled();
    expect(client.unfreezeConfig).toHaveBeenCalledOnce();
  });

  it("fails before transfer when the queued mode no longer matches the gateway classes", async () => {
    const { deps, client } = makeDeps({
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-only"),
    });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({ input: {
      uid: "uid-alice",
      toGatewayId: "gw-green",
      systemConfigMigrationMode: "checkpoint-and-restore",
    } }), makeCtx());

    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/mode changed/i),
    });
    expect(client.freezeConfig).not.toHaveBeenCalled();
    expect(client.transferState).not.toHaveBeenCalled();
  });

  it("fails before freeze when the exact fleet control protocol barrier is not satisfied", async () => {
    const assertSystemConfigProtocolReady = vi.fn(async () => {
      throw new Error("durable-openclaw-config protocol v1 is not fleet-ready");
    });
    const { deps, client } = makeDeps({
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-and-restore"),
      assertSystemConfigProtocolReady,
    });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({ input: {
      uid: "uid-alice",
      toGatewayId: "gw-green",
      systemConfigMigrationMode: "checkpoint-and-restore",
    } }), makeCtx());

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/not fleet-ready/i) });
    expect(client.freezeConfig).not.toHaveBeenCalled();
    expect(client.transferState).not.toHaveBeenCalled();
  });

  it("persists the planned-roll checkpoint and target proof as operation output", async () => {
    const { deps, client } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "default" })),
      resolveFromRevision: vi.fn(async () => ({ revisionId: "default-r1", release: 1, epoch: 0 })),
      resolvePlacement: vi.fn(async () => ({ ok: true as const, revisionId: "default-r2", release: 2 })),
      resolveSystemConfigMigrationMode: vi.fn(async () => "checkpoint-and-restore"),
    });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({ input: {
      uid: "uid-alice",
      toGatewayId: "default",
      source: "release-roll",
      rollOperationId: "roll-default-r2-1",
      systemConfigMigrationMode: "checkpoint-and-restore",
    } }), makeCtx());

    expect(result.success).toBe(true);
    expect(client.freezeConfig).toHaveBeenCalledWith(expect.objectContaining({
      transportId: "default-r1",
    }));
    expect(client.proveConfigRestore).toHaveBeenCalledWith(expect.objectContaining({
      transportId: "default-r2",
      checkpointCommit: "a".repeat(40),
    }));
    const rollFence = {
      uid: "uid-alice",
      gatewayId: "default",
      rollOperationId: "roll-default-r2-1",
      targetRevisionId: "default-r2",
      targetRelease: 2,
      sourceRevisionId: "default-r1",
      sourceEpoch: 0,
    };
    expect(deps.assertRollFence).toHaveBeenCalledWith(rollFence);
    expect(deps.recordConfigProof).toHaveBeenCalledWith(
      "default-r2",
      expect.objectContaining({
        migrationId: "mig-test-1",
        builderSlug: "alice",
        checkpointCommit: "a".repeat(40),
        acceptedCommit: "c".repeat(40),
      }),
      rollFence,
    );
    expect(deps.recordConfigRollMetric).toHaveBeenCalledWith({
      stage: "checkpoint", result: "ok", gatewayId: "default", revisionId: "default-r1",
    });
    expect(deps.recordConfigRollMetric).toHaveBeenCalledWith({
      stage: "proof", result: "ok", gatewayId: "default", revisionId: "default-r2",
    });
    expect(deps.recordConfigRollMetric).not.toHaveBeenCalledWith(expect.objectContaining({
      stage: "unfreeze",
    }));
    expect(client.unfreezeConfig).not.toHaveBeenCalled();
    expect(result.output).toEqual({
      configCheckpoint: {
        checkpointCommit: "a".repeat(40),
        configHash: "b".repeat(64),
      },
      configProof: {
        restoredCommit: "a".repeat(40),
        acceptedCommit: "c".repeat(40),
        configHash: "d".repeat(64),
        configReady: true,
        observedRevisionId: "default-r2",
        restoreProvenAt: 100,
        configReadyAt: 101,
        runtimeConfigHash: "runtime-after",
      },
    });
  });

  it("rejects a superseded roll before freezing or transferring state", async () => {
    const assertRollFence = vi.fn(async () => {
      throw new Error("stale release-roll fence");
    });
    const { deps, client } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "default" })),
      resolveFromRevision: vi.fn(async () => ({
        revisionId: "default-r1",
        release: 1,
        epoch: 7,
      })),
      resolvePlacement: vi.fn(async () => ({
        ok: true as const,
        revisionId: "default-r2",
        release: 2,
      })),
      assertRollFence,
    });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({ input: {
      uid: "uid-alice",
      toGatewayId: "default",
      source: "release-roll",
      rollOperationId: "roll-old",
      systemConfigMigrationMode: "checkpoint-and-restore",
    } }), makeCtx());

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/stale release-roll/i) });
    expect(result.output).toBeUndefined();
    expect(client.unfreezeConfig).not.toHaveBeenCalled();
    expect(client.freezeConfig).not.toHaveBeenCalled();
    expect(client.transferState).not.toHaveBeenCalled();
  });

  it("ACCEPTS a same-gateway drain when the resolved from/to REVISIONS differ", async () => {
    const commitCutover = vi.fn(async () => undefined);
    const resolveGatewayUrl = vi.fn(async (id: string) => `http://test/${id}`);
    const { deps, client } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "default" })),
      resolveGatewayUrl,
      resolveFromRevision: vi.fn(async () => ({ revisionId: "default-r1", release: 1 })),
      resolvePlacement: vi.fn(async () => ({ ok: true as const, revisionId: "default-r2", release: 2 })),
      commitCutover,
    });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(
      mkOp({ input: {
        uid: "uid-alice",
        toGatewayId: "default",
        source: "release-roll",
        rollOperationId: "roll-1",
      } }),
      makeCtx(),
    );

    expect(result.success).toBe(true);
    // Transport URLs resolve from the REVISION service names, not the bare gateway.
    expect(resolveGatewayUrl).toHaveBeenCalledWith("default-r1");
    expect(resolveGatewayUrl).toHaveBeenCalledWith("default-r2");
    // In-pod path/body stays bare — the migration client is handed the bare gatewayId.
    expect(client.quiesce).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "default" }));
    // The cutover commits the assignment to the target revision, mirror unflipped.
    expect(commitCutover).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: "uid-alice",
        toGatewayId: "default",
        flipMirror: false,
        revision: { revisionId: "default-r2", release: 2 },
      }),
    );
  });

  it("REJECTS a drain onto the SAME revision (no-op) instead of the bare-gateway check", async () => {
    const { deps, client } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "default" })),
      resolveFromRevision: vi.fn(async () => ({ revisionId: "default-r2", release: 2 })),
      resolvePlacement: vi.fn(async () => ({ ok: true as const, revisionId: "default-r2", release: 2 })),
    });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(
      mkOp({ input: { uid: "uid-alice", toGatewayId: "default" } }),
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already on default-r2/);
    expect(client.quiesce).not.toHaveBeenCalled();
  });

  // P1-3: a same-gateway drain with a resolved target but NO source assignment doc
  // must RUN — the source revision falls back to the gateway's live revision, so
  // it does not silently no-op as "already on target".
  it("RUNS a same-gateway drain when there is no source assignment doc (source falls back to live revision)", async () => {
    const commitCutover = vi.fn(async () => undefined);
    const { deps, client } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "default" })),
      // No assignment doc → resolver returns the gateway's LIVE revision (r1).
      resolveFromRevision: vi.fn(async () => ({ revisionId: "default-r1", release: 1 })),
      resolvePlacement: vi.fn(async () => ({ ok: true as const, revisionId: "default-r2", release: 2 })),
      commitCutover,
    });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(
      mkOp({ input: {
        uid: "uid-alice",
        toGatewayId: "default",
        source: "release-roll",
        rollOperationId: "roll-1",
      } }),
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(client.quiesce).toHaveBeenCalled(); // migration actually ran
    expect(commitCutover).toHaveBeenCalledWith(
      expect.objectContaining({ revision: { revisionId: "default-r2", release: 2 } }),
    );
  });

  it("does NOT flip the user mirror on a same-gateway drain (commit carries flipMirror=false)", async () => {
    const commitCutover = vi.fn(async () => undefined);
    const { deps } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "default" })),
      resolveFromRevision: vi.fn(async () => ({ revisionId: "default-r1", release: 1 })),
      resolvePlacement: vi.fn(async () => ({ ok: true as const, revisionId: "default-r2", release: 2 })),
      commitCutover,
    });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(
      mkOp({ input: {
        uid: "uid-alice",
        toGatewayId: "default",
        source: "release-roll",
        rollOperationId: "roll-1",
      } }),
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(commitCutover).toHaveBeenCalledTimes(1);
    expect(commitCutover).toHaveBeenCalledWith(expect.objectContaining({ flipMirror: false }));
  });

  it("rejects when placement resolves but the target revision is not ready", async () => {
    const { deps, client } = makeDeps({
      readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "default" })),
      resolveFromRevision: vi.fn(async () => ({ revisionId: "default-r1", release: 1 })),
      resolvePlacement: vi.fn(async () => ({ ok: false as const, reason: "revision-not-ready" as const })),
    });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(
      mkOp({ input: { uid: "uid-alice", toGatewayId: "default" } }),
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/revision-not-ready/);
    expect(client.quiesce).not.toHaveBeenCalled();
  });

  it("rejects a migration when the destination has no durable root placement", async () => {
    const commitCutover = vi.fn(async () => undefined);
    const resolveGatewayUrl = vi.fn(async (id: string) => `http://test/${id}`);
    const { deps } = makeDeps({
      commitCutover,
      resolveGatewayUrl,
      resolveFromRevision: vi.fn(async () => ({ revisionId: "gw-blue-r1", release: 1 })),
      resolvePlacement: vi.fn(async () => null),
    });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(mkOp({ input: { uid: "uid-alice", toGatewayId: "gw-green" } }), makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/target gateway .* no durable placement/i);
    expect(resolveGatewayUrl).not.toHaveBeenCalled();
    expect(commitCutover).not.toHaveBeenCalled();
  });

  it("rejects a migration when the source has no durable revision", async () => {
    const resolveGatewayUrl = vi.fn(async (id: string) => `http://test/${id}`);
    const { deps, client } = makeDeps({
      resolveGatewayUrl,
      resolveFromRevision: vi.fn(async () => null),
      resolvePlacement: vi.fn(async () => ({
        ok: true as const,
        revisionId: "gw-green-r1",
        release: 1,
      })),
    });
    const handler = createMigrateCustomerHandler(deps);
    const result = await handler(mkOp({ input: { uid: "uid-alice", toGatewayId: "gw-green" } }), makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/source gateway .* no durable revision/i);
    expect(resolveGatewayUrl).not.toHaveBeenCalled();
    expect(client.quiesce).not.toHaveBeenCalled();
  });
});

describe("createMigrateCustomerHandler — failures + rollback", () => {
  it("propagates migration failure and rollback flag from runMigration", async () => {
    const client = happyClient();
    let transferCount = 0;
    client.transferState = vi.fn(async ({ migrationId, slug }) => {
      transferCount++;
      if (transferCount === 3) throw new Error("export: 503 upstream draining");
      return { migrationId, slug, imported: true };
    }) as MigrationClient["transferState"];

    const { deps } = makeDeps({}, client);
    const handler = createMigrateCustomerHandler(deps);
    const ctx = makeCtx();
    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/503/);
    expect(result.rolledBack).toBe(true);

    const failedStep = ctx.reported.find((s) => s.status === "failed");
    expect(failedStep?.name).toBe("final-sync-state");
    expect(failedStep?.error).toMatch(/503/);

    const rollbackSteps = ctx.reported.filter((s) => s.name.startsWith("rollback:"));
    expect(rollbackSteps.length).toBeGreaterThan(0);
  });
});

describe("createMigrateCustomerHandler — post-cutover source cleanup", () => {
  it("keeps the verified target cutover and reports source cleanup as skipped", async () => {
    const client = happyClient();
    client.unmount = vi.fn(async ({ migrationId, slug, gatewayId }) => {
      if ((client.unmount as ReturnType<typeof vi.fn>).mock.calls.length === 1) {
        throw new Error("rate limit exceeded for config.patch; retry after 16s");
      }
      return { migrationId, slug, unmounted: true, gatewayId };
    }) as MigrationClient["unmount"];
    const { deps } = makeDeps({}, client);
    const handler = createMigrateCustomerHandler(deps);
    const ctx = makeCtx();

    const res = await handler(
      mkOp({ input: {
        uid: "uid-alice",
        toGatewayId: "gw-green",
        source: "release-roll",
        rollOperationId: "roll-1",
      } }),
      ctx,
    );

    expect(res.success).toBe(true);
    expect(res.rolledBack).toBe(false);
    expect(ctx.reported).toContainEqual(
      expect.objectContaining({
        name: "unmount-source",
        status: "skipped",
        error: "rate limit exceeded for config.patch; retry after 16s",
      }),
    );
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("cleanup failed after durable cutover"),
    );
  });

  it("a revision drain marks the assignment quiescing BEFORE the quiesce RPC (threads setAssignmentState)", async () => {
    const calls: string[] = [];
    const client = happyClient();
    client.quiesce = vi.fn(async ({ migrationId, slug }) => {
      calls.push("quiesce");
      return { migrationId, slug, drained: true, runningCount: 0 };
    }) as MigrationClient["quiesce"];
    const { deps } = makeDeps(
      {
        readUser: vi.fn(async () => ({ slug: "alice", currentGatewayId: "default" })),
        resolveFromRevision: vi.fn(async () => ({ revisionId: "default-r1", release: 1 })),
        resolvePlacement: vi.fn(async () => ({ ok: true as const, revisionId: "default-r2", release: 2 })),
        setAssignmentState: vi.fn(async ({ state }) => {
          calls.push(`roster:${state}`);
        }),
      },
      client,
    );
    const handler = createMigrateCustomerHandler(deps);
    const res = await handler(
      mkOp({ input: { uid: "uid-alice", toGatewayId: "default" } }),
      makeCtx(),
    );
    expect(res.success).toBe(true);
    expect(calls).toEqual(["roster:quiescing", "quiesce"]);
  });
});
