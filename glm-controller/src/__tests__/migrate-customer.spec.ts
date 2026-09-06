import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import { createMigrateCustomerHandler } from "../handlers/migrate-customer";
import type { MigrateCustomerDeps } from "../handlers/migrate-customer";
import type { OperationContext } from "../operation-router";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { GatewayArtifact } from "@octogee/core/gateway-live-release";

const SOURCE_SYSTEM_CONFIG_COMMIT = "a".repeat(40);

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
} as unknown as FleetBrokerUserSnapshot;

function gatewayRootFence(
  gatewayId: string,
  release = 1,
): NonNullable<Operation["customerMigrationV2"]>["sourceRootFence"] {
  return {
    gatewayId,
    updatedAt: gatewayId === "gw-blue" ? 17 : 18,
    latestRelease: release,
    desiredRelease: release,
    liveRelease: release,
    gatewayClass: "builder",
    ownerUid: "uid-alice",
    builderSlug: "alice",
    configHash: gatewayId === "gw-blue" ? "7".repeat(64) : "8".repeat(64),
  };
}

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

function happyClient(): MigrationClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    restoreTarget: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`restore:${gatewayId}`);
      return { migrationId: "mig-op-1", slug, restored: true, steps: [] };
    }) as MigrationClient["restoreTarget"],
    quiesce: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`quiesce:${gatewayId}`);
      return { migrationId: "mig-op-1", slug, drained: true, runningCount: 0 };
    }) as MigrationClient["quiesce"],
    flushGateway: vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      ok: true,
      durationMs: 1,
      systemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
      steps: [],
    })) as MigrationClient["flushGateway"],
    transferState: vi.fn(async ({ fromGatewayId, toGatewayId, slug, mode }) => {
      calls.push(`transfer:${mode ?? "default"}:${fromGatewayId}->${toGatewayId}`);
      return { migrationId: "mig-op-1", slug, imported: true };
    }) as MigrationClient["transferState"],
    verifyTarget: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`verify:${gatewayId}`);
      return {
        migrationId: "mig-op-1",
        slug,
        ready: true,
        checks: { customerDir: true, coachWired: true, mountMarked: true, accountHealthy: true },
      };
    }) as MigrationClient["verifyTarget"],
    unmount: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`unmount:${gatewayId}`);
      return { migrationId: "mig-op-1", slug, unmounted: true };
    }) as MigrationClient["unmount"],
    calls,
  } as MigrationClient & { calls: string[] };
}

interface HarnessOptions {
  client?: MigrationClient & { calls: string[] };
  durable?: boolean;
  sourceGatewayId?: string;
  openclawVersions?: Record<string, string | null>;
  targetArtifact?: GatewayArtifact | null;
}

const SAME_OPENCLAW = "OpenClaw 2026.7.2-beta.7 (aaaaaaaa)";
const SAME_OPENCLAW_VERSION = "2026.7.2-beta.7";

function targetArtifact(version = SAME_OPENCLAW_VERSION): GatewayArtifact {
  return {
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    imageTag: `deadbee-oc${version}@sha256:${"b".repeat(64)}`,
    openclawSourceSha: "a".repeat(40),
    profileImages: {
      builder: {
        imageRepository:
          "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder",
        imageTag: `deadbee-oc${version}@sha256:${"c".repeat(64)}`,
      },
    },
  };
}

function configuredTargetArtifact(options: HarnessOptions): GatewayArtifact | null {
  if (options.targetArtifact !== undefined) return options.targetArtifact;
  const configured = options.openclawVersions?.["gw-green"];
  if (configured === null || configured === "unknown") return null;
  return targetArtifact(configured ?? SAME_OPENCLAW_VERSION);
}

function mkDeps(options: HarnessOptions = {}) {
  const client = options.client ?? happyClient();
  const events: string[] = [];
  const persisted: Array<NonNullable<Operation["customerMigrationV2"]>> = [];
  const deps: MigrateCustomerDeps = {
    readUser: vi.fn(async () => ({
      slug: "alice",
      currentGatewayId: options.sourceGatewayId ?? "gw-blue",
    })),
    readUserSnapshot: vi.fn(async () => SNAPSHOT),
    prepareNativeComputerReturn: vi.fn(async () => null),
    readGatewayOpenclawVersion: vi.fn(async (gatewayId: string) =>
      options.openclawVersions
        ? options.openclawVersions[gatewayId] ?? null
        : SAME_OPENCLAW),
    readGatewayReleaseArtifact: vi.fn(async (_gatewayId: string, release: number) =>
      release === 2 ? configuredTargetArtifact(options) : null),
    commitCutover: vi.fn(async (commit) => {
      events.push(`cutover:${commit.fromGatewayId}->${commit.toGatewayId}:mirror=${commit.flipMirror}`);
    }),
    resolveGatewayUrl: vi.fn(async (gatewayId: string) => `http://${gatewayId}.svc:3003`),
    reportMigrationProgress: vi.fn(async () => undefined),
    buildClient: vi.fn(() => client),
    resolveSourcePlacement: vi.fn(async () => ({
      release: 1,
      epoch: 4,
      assignmentMode: "assigned" as const,
    })),
    resolveTargetPlacement: vi.fn(async () => ({ ok: true as const, release: 2 })),
    setAssignmentState: vi.fn(async (input) => {
      events.push(`assignment:${input.gatewayId}:${input.state}`);
    }),
    readGatewayRootFence: vi.fn(async (gatewayId: string) => gatewayRootFence(
      gatewayId,
      gatewayId === "gw-blue" ? 1 : 2,
    )),
    commitV2Cutover: vi.fn(async (input) => {
      events.push(`v2-cutover:${input.sourceGatewayId}->${input.targetGatewayId}`);
    }),
    useDurableMigration: vi.fn(async () => options.durable === true),
    genMigrationId: (operationId: string) => `mig-${operationId}`,
    now: vi.fn(() => 5_000),
    log: vi.fn(),
  };
  const steps: OperationStep[] = [];
  const ctx: OperationContext = {
    reportStep: vi.fn(async (step: OperationStep) => {
      steps.push(step);
    }),
    persistCustomerMigrationV2: vi.fn(async (state) => {
      persisted.push(state);
    }),
  } as unknown as OperationContext;
  return { deps, ctx, client, events, steps, persisted };
}

describe("native computer return", () => {
  it.each([false, true])("checkpoints native state before Shared cutover (resumed=%s)", async (requested) => {
    const { deps, ctx, client, events } = mkDeps();
    const native = {
      checkpointRequested: requested,
      checkpoint: vi.fn(async () => { events.push("native-checkpoint"); }),
      release: vi.fn(async () => {}),
    };
    deps.prepareNativeComputerReturn = vi.fn(async () => native);
    const result = await createMigrateCustomerHandler(deps)(mkOp({}), ctx);
    expect(result.success).toBe(true);
    expect(native.checkpoint).toHaveBeenCalledOnce();
    expect(events.indexOf("native-checkpoint")).toBeLessThan(events.indexOf("cutover:gw-blue->gw-green:mirror=true"));
    expect(client.transferState).not.toHaveBeenCalled();
    expect(client.unmount).toHaveBeenCalledOnce();
    expect(client.flushGateway).toHaveBeenCalledTimes(requested ? 0 : 1);
    expect(native.release).toHaveBeenCalledOnce();
  });

  it("finishes source cleanup when a retry finds the native return already cut over", async () => {
    const { deps, ctx, client } = mkDeps({ sourceGatewayId: "gw-green" });
    const native = { checkpointRequested: true, checkpoint: vi.fn(), release: vi.fn(async () => {}) };
    deps.prepareNativeComputerReturn = vi.fn(async () => native);
    const result = await createMigrateCustomerHandler(deps)(mkOp({ input: {
      uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease",
    } }), ctx);
    expect(result.success).toBe(true);
    expect(native.release).toHaveBeenCalledOnce();
    expect(client.unmount).toHaveBeenCalledOnce();
    expect(client.flushGateway).not.toHaveBeenCalled();
    expect(native.checkpoint).not.toHaveBeenCalled();
  });

  it("rolls forward after an uncertain cutover response when Shared already owns the Builder", async () => {
    const { deps, ctx, client } = mkDeps();
    const native = { checkpointRequested: false, checkpoint: vi.fn(async () => {}), release: vi.fn(async () => {}) };
    deps.prepareNativeComputerReturn = vi.fn(async () => native);
    vi.mocked(deps.commitCutover).mockImplementation(async () => {
      vi.mocked(deps.readUser).mockResolvedValue({ slug: "alice", currentGatewayId: "gw-green" });
      throw new Error("lost response");
    });
    const result = await createMigrateCustomerHandler(deps)(mkOp({}), ctx);
    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(native.release).toHaveBeenCalledOnce();
    expect(client.unmount).toHaveBeenCalledOnce();
    expect(deps.setAssignmentState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "serving" }));
  });

  it("keeps the source assignment when the native checkpoint fails", async () => {
    const { deps, ctx, client } = mkDeps();
    const native = {
      checkpointRequested: false,
      checkpoint: vi.fn(async () => { throw new Error("checkpoint timed out"); }),
      release: vi.fn(async () => {}),
    };
    deps.prepareNativeComputerReturn = vi.fn(async () => native);
    const result = await createMigrateCustomerHandler(deps)(mkOp({}), ctx);
    expect(result).toMatchObject({ success: false, rolledBack: true, error: "checkpoint timed out" });
    expect(deps.commitCutover).not.toHaveBeenCalled();
    expect(client.unmount).not.toHaveBeenCalled();
    expect(native.release).toHaveBeenCalledOnce();
    expect(deps.setAssignmentState).toHaveBeenLastCalledWith(expect.objectContaining({ state: "serving" }));
  });
});

describe("migrate-customer — input validation", () => {
  it.each([
    [{ toGatewayId: "gw-green" }, /missing uid/u],
    [{ uid: "uid-alice" }, /missing toGatewayId/u],
  ])("rejects malformed input %j", async (input, message) => {
    const { deps, ctx } = mkDeps();
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({ input: input as Operation["input"] }), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(message);
  });

  it("rejects a migration whose declared source no longer matches the user's gateway", async () => {
    const { deps, ctx } = mkDeps();
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({
      input: { uid: "uid-alice", toGatewayId: "gw-green", fromGatewayId: "gw-stale" },
    }), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.error).toMatch(/declared source gw-stale does not match resolved source gw-blue/u);
  });

  it("binds legacy source roster gates to the migration operation", async () => {
    const { deps, ctx } = mkDeps();
    const handler = createMigrateCustomerHandler(deps);

    await handler(mkOp({}), ctx);

    expect(deps.setAssignmentState).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "gw-blue",
      uid: "uid-alice",
      updatedByOperationId: "op-1",
    }));
  });

  it("rejects a same-gateway migration — simple-roll has one pod per gateway", async () => {
    const { deps, ctx } = mkDeps({ sourceGatewayId: "gw-green" });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already on gw-green/u);
  });

  it("converges a stale builder activation migration after another controller reaches its target", async () => {
    const { deps, ctx, client } = mkDeps({ sourceGatewayId: "gw-green" });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({
      input: {
        uid: "uid-alice",
        fromGatewayId: "gw-blue",
        toGatewayId: "gw-green",
        source: "builder-activation-lease",
      },
    }), ctx);

    expect(result).toEqual({ steps: [], success: true, rolledBack: false });
    expect(client.calls).toEqual([]);
  });

  it("fails when the target placement is rejected", async () => {
    const { deps, ctx } = mkDeps();
    (deps.resolveTargetPlacement as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: "revision-not-ready",
    });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/placement rejected for gw-green: revision-not-ready/u);
  });
});

describe("migrate-customer — legacy data-plane migration (shared class)", () => {
  it("runs the full flow with the roster gate and no config steps", async () => {
    const { deps, ctx, client, events } = mkDeps();
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(client.calls).toEqual([
      "transfer:keys:gw-blue->gw-green",
      "transfer:pre:gw-blue->gw-green",
      "quiesce:gw-blue",
      "transfer:final:gw-blue->gw-green",
      "verify:gw-green",
      "unmount:gw-blue",
    ]);
    expect(events).toContain("assignment:gw-blue:quiescing");
    expect(events).toContain("cutover:gw-blue->gw-green:mirror=true");
    expect(client.calls.every((call) => !/config/u.test(call))).toBe(true);
    expect(client.restoreTarget).not.toHaveBeenCalled();
    expect(deps.readUserSnapshot).toHaveBeenCalledWith("uid-alice", "gw-green");
  });

  it("reports failure with rollback when quiesce cannot drain", async () => {
    const client = happyClient();
    (client.quiesce as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("agents busy"));
    const { deps, ctx, events } = mkDeps({ client });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.error).toMatch(/agents busy/u);
    expect(events.some((event) => event.startsWith("cutover:"))).toBe(false);
    expect(events).toContain("assignment:gw-blue:serving");
  });
});

describe("migrate-customer — state transfer across OpenClaw identities", () => {
  const CROSS_VERSION = { "gw-blue": "OpenClaw 2026.7.1 (aaaaaaaa)", "gw-green": "2026.7.2-beta.7" };
  it.each([false, true])("transfers and verifies across versions with durable=%s", async (durable) => {
    const { deps, ctx, client } = mkDeps({ durable, openclawVersions: CROSS_VERSION });
    const result = await createMigrateCustomerHandler(deps)(mkOp({}), ctx);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ stateMigration: { strategy: "migrate-state" } });
    expect(client.transferState).toHaveBeenCalled();
    expect(client.verifyTarget).toHaveBeenCalled();
  });

  it.each([false, true])("transfers across source builds with durable=%s", async (durable) => {
    const { deps, ctx, client } = mkDeps({ durable,
      targetArtifact: { ...targetArtifact(), openclawSourceSha: "b".repeat(40) },
    });
    const result = await createMigrateCustomerHandler(deps)(mkOp({}), ctx);
    expect(result.success).toBe(true);
    expect(client.transferState).toHaveBeenCalled();
    expect(client.verifyTarget).toHaveBeenCalled();
  });

  it.each([false, true])("does not require OpenClaw metadata with durable=%s", async (durable) => {
    const { deps, ctx, client } = mkDeps({ durable,
      openclawVersions: { "gw-blue": null, "gw-green": null },
      targetArtifact: { ...targetArtifact(), imageTag: `deadbee@sha256:${"b".repeat(64)}`, openclawSourceSha: undefined, profileImages: undefined },
    });
    const result = await createMigrateCustomerHandler(deps)(mkOp({}), ctx);
    expect(result.success).toBe(true);
    expect(client.transferState).toHaveBeenCalled();
    expect(client.verifyTarget).toHaveBeenCalled();
  });
});

describe("persisted fresh migration recovery", () => {
  it.each(["gw-green", "gw-blue", "unrelated"])("reconciles canonical owner %s without unmounting the target", async (owner) => {
    const initial = mkDeps({ durable: true });
    await createMigrateCustomerHandler(initial.deps)(mkOp({}), initial.ctx);
    const state = { ...initial.persisted[0]!, strategy: "provision-fresh" as const, phase: "freshCutoverReady" as const };
    const h = mkDeps({ durable: true });
    vi.mocked(h.deps.readUser).mockResolvedValue({ slug: "alice", currentGatewayId: owner });
    const result = await createMigrateCustomerHandler(h.deps)(mkOp({ customerMigrationV2: state }), h.ctx);
    expect(h.client.unmount).not.toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-green" }));
    expect(h.client.transferState).not.toHaveBeenCalled();
    if (owner === "gw-green") {
      expect(result.success).toBe(true);
      expect(h.deps.commitV2Cutover).toHaveBeenCalledWith(expect.objectContaining({ strategy: "provision-fresh", migrationId: state.migrationId }));
      expect(h.persisted.at(-1)?.phase).toBe("complete");
    } else if (owner === "gw-blue") {
      expect(result).toMatchObject({ success: false, rolledBack: true });
      expect(h.deps.setAssignmentState).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-blue", state: "serving", createIfMissing: false }));
      expect(h.persisted.at(-1)?.phase).toBe("aborted");
    } else {
      expect(result.success).toBe(false);
      expect(h.deps.setAssignmentState).not.toHaveBeenCalled();
      expect(h.client.unmount).not.toHaveBeenCalled();
    }
  });
});

describe("migrate-customer — durable V2 migration", () => {
  it("initializes durable state from exact root fences and drives to complete", async () => {
    const { deps, ctx, client, events, persisted } = mkDeps({ durable: true });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(persisted[0]).toMatchObject({
      phase: "initialized",
      operationId: "op-1",
      migrationId: "mig-op-1",
      uid: "uid-alice",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceRelease: 1,
      sourceEpoch: 4,
      sourceAssignmentMode: "assigned",
      targetGatewayId: "gw-green",
      targetRelease: 2,
    });
    expect(persisted.map((state) => state.phase)).toEqual([
      "initialized", "keysSynced", "preSynced", "sourceQuiesced",
      "finalSynced", "targetVerified", "cutover", "sourceRetired", "complete",
    ]);
    expect(client.calls).toEqual([
      "transfer:keys:gw-blue->gw-green",
      "transfer:pre:gw-blue->gw-green",
      "quiesce:gw-blue",
      "transfer:final:gw-blue->gw-green",
      "verify:gw-green",
      "unmount:gw-blue",
    ]);
    expect(client.restoreTarget).not.toHaveBeenCalled();
    expect(events).toContain("v2-cutover:gw-blue->gw-green");
    expect(deps.readUserSnapshot).not.toHaveBeenCalled();
    expect(client.flushGateway).toHaveBeenLastCalledWith(expect.objectContaining({
      gatewayId: "gw-green",
      expectedSystemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
      reason: "migration-converge",
    }));
  });

  it("refuses initialization when the source root ownership changed", async () => {
    const { deps, ctx } = mkDeps({ durable: true });
    (deps.readGatewayRootFence as ReturnType<typeof vi.fn>).mockImplementation(
      async (gatewayId: string) => gatewayId === "gw-blue"
        ? { ...gatewayRootFence("gw-blue"), ownerUid: "someone-else" }
        : gatewayRootFence("gw-green", 2),
    );
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/source root ownership changed/u);
  });

  it("resumes a durable migration from its persisted phase without re-running earlier steps", async () => {
    const { deps, ctx, client } = mkDeps({ durable: true });
    const handler = createMigrateCustomerHandler(deps);
    const state = {
      phase: "sourceQuiesced" as const,
      operationId: "op-1",
      migrationId: "mig-op-1",
      uid: "uid-alice",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceRelease: 1,
      sourceEpoch: 4,
      sourceAssignmentMode: "assigned" as const,
      sourceSystemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
      sourceRootFence: gatewayRootFence("gw-blue"),
      targetGatewayId: "gw-green",
      targetRelease: 2,
      targetRootFence: gatewayRootFence("gw-green", 2),
    };

    const result = await handler(mkOp({ customerMigrationV2: state }), ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(client.calls).toEqual([
      "transfer:final:gw-blue->gw-green",
      "verify:gw-green",
      "unmount:gw-blue",
    ]);
  });

  it("re-checks the initial bindings when resuming from initialized and refuses drift", async () => {
    const { deps, ctx } = mkDeps({ durable: true });
    (deps.resolveSourcePlacement as ReturnType<typeof vi.fn>).mockResolvedValue({
      release: 9,
      epoch: 4,
      assignmentMode: "assigned",
    });
    const handler = createMigrateCustomerHandler(deps);
    const state = {
      phase: "initialized" as const,
      operationId: "op-1",
      migrationId: "mig-op-1",
      uid: "uid-alice",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceRelease: 1,
      sourceEpoch: 4,
      sourceAssignmentMode: "assigned" as const,
      sourceRootFence: gatewayRootFence("gw-blue"),
      targetGatewayId: "gw-green",
      targetRelease: 2,
      targetRootFence: gatewayRootFence("gw-green", 2),
    };

    const result = await handler(mkOp({ customerMigrationV2: state }), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/source placement changed/u);
  });

  it("classifies a transport failure as a 503 retry without aborting durable state", async () => {
    const client = happyClient();
    (client.transferState as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("fetch failed"), { retryable: true }),
    );
    const { deps, ctx, persisted } = mkDeps({ durable: true, client });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/retry pending: status 503/u);
    expect(persisted.map((state) => state.phase)).toEqual(["initialized"]);
  });

  it("aborts a transient final-sync failure after source quiesce before returning retry", async () => {
    const client = happyClient();
    (client.transferState as ReturnType<typeof vi.fn>).mockImplementation(async ({ mode }) => {
      if (mode === "final") {
        throw Object.assign(
          new Error("system config mutation unavailable: writer-lock-busy"),
          { retryable: true },
        );
      }
      return { migrationId: "mig-op-1", slug: "alice", imported: true };
    });
    const { deps, ctx, events, persisted } = mkDeps({ durable: true, client });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(persisted.map((state) => state.phase)).toEqual([
      "initialized", "keysSynced", "preSynced", "sourceQuiesced",
      "abortIntent", "abortTargetUnmounted", "aborted",
    ]);
    expect(client.calls.filter((call) => call.startsWith("unmount:"))).toEqual(["unmount:gw-green"]);
    expect(events).toContain("assignment:gw-blue:serving");
  });

  it("replays an ambiguous cutover commit instead of aborting the canonical target", async () => {
    const { deps, ctx, client, persisted } = mkDeps({ durable: true });
    const commitV2Cutover = deps.commitV2Cutover as ReturnType<typeof vi.fn>;
    commitV2Cutover.mockRejectedValueOnce(
      Object.assign(new Error("cutover response unavailable"), { retryable: true }),
    );
    const handler = createMigrateCustomerHandler(deps);

    const first = await handler(mkOp({}), ctx);

    expect(first).toMatchObject({ success: false, rolledBack: false });
    expect(first.error).toMatch(/retry pending: status 503/u);
    expect(persisted.at(-1)?.phase).toBe("targetVerified");
    expect(client.calls.filter((call) => call.startsWith("unmount:"))).toEqual([]);

    const replay = await handler(mkOp({
      customerMigrationV2: persisted.at(-1),
    }), ctx);

    expect(replay).toMatchObject({ success: true, rolledBack: false });
    expect(commitV2Cutover).toHaveBeenCalledTimes(2);
    expect(client.calls.filter((call) => call.startsWith("unmount:"))).toEqual([
      "unmount:gw-blue",
    ]);
  });

  it("aborts on a terminal mid-flight failure: unmounts the target and restores the source", async () => {
    const client = happyClient();
    (client.verifyTarget as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("target verify failed"), { status: 409 }),
    );
    const { deps, ctx, client: c, events, persisted } = mkDeps({ durable: true, client });
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(persisted.map((state) => state.phase)).toEqual([
      "initialized", "keysSynced", "preSynced", "sourceQuiesced",
      "finalSynced", "abortIntent", "abortTargetUnmounted", "aborted",
    ]);
    expect(c.calls.filter((call) => call.startsWith("unmount:"))).toEqual(["unmount:gw-green"]);
    expect(events).toContain("assignment:gw-blue:serving");
  });

  it("replays a completed durable migration idempotently and refuses changed input", async () => {
    const { deps, ctx } = mkDeps({ durable: true });
    const handler = createMigrateCustomerHandler(deps);
    const state = {
      phase: "complete" as const,
      operationId: "op-1",
      migrationId: "mig-op-1",
      uid: "uid-alice",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceRelease: 1,
      sourceEpoch: 4,
      sourceAssignmentMode: "assigned" as const,
      sourceRootFence: gatewayRootFence("gw-blue"),
      targetGatewayId: "gw-green",
      targetRelease: 2,
      targetRootFence: gatewayRootFence("gw-green", 2),
    };

    await expect(handler(mkOp({ customerMigrationV2: state }), ctx)).resolves.toMatchObject({
      success: true,
      rolledBack: false,
    });
    await expect(handler(mkOp({
      customerMigrationV2: state,
      input: { uid: "uid-alice", toGatewayId: "gw-other" },
    }), ctx)).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/input changed/u),
    });
  });

  it("turns a cancellation request into a durable abort once transfer started", async () => {
    const { deps, client, events } = mkDeps({ durable: true });
    const persisted: Array<NonNullable<Operation["customerMigrationV2"]>> = [];
    let cancelRequested = false;
    const ctx: OperationContext = {
      reportStep: vi.fn(async () => undefined),
      persistCustomerMigrationV2: vi.fn(async (state) => {
        persisted.push(state);
        if (state.phase === "preSynced") cancelRequested = true;
      }),
      cancellationRequested: vi.fn(async () => cancelRequested),
    } as unknown as OperationContext;
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.error).toMatch(/superseded/u);
    expect(deps.reportMigrationProgress).toHaveBeenCalledWith("gw-green", expect.objectContaining({ phase: "preSynced", status: "skipped" }));
    expect(deps.reportMigrationProgress).toHaveBeenCalledWith("gw-green", expect.objectContaining({ phase: "abortIntent", status: "running" }));
    expect(persisted.map((state) => state.phase)).toContain("abortIntent");
    expect(client.calls.filter((call) => call.startsWith("unmount:"))).toEqual(["unmount:gw-green"]);
    expect(events).toContain("assignment:gw-blue:serving");
  });
});
