import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import { createMigrateCustomerHandler } from "../handlers/migrate-customer";
import type { MigrateCustomerDeps } from "../handlers/migrate-customer";
import type { OperationContext } from "../operation-router";
import { MigrationRpcError, type MigrationClient } from "@octogee/core/fleet-migration-client";
import {
  ADD_CUSTOMER_DEADLINE_MS,
  MIGRATION_VERIFY_COACH_ATTACH_IN_PROGRESS,
} from "@octogee/shared/types/fleet-controller";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { GatewayArtifact } from "@octogee/core/gateway-live-release";
import { classifyOperationFailure } from "../operation-retry";

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
    schedulerReady: vi.fn(async () => undefined),
    scheduler: vi.fn(async ({ migrationId, phase }) => ({ operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: { retainedJobIds: [] } })),
    restoreTarget: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`restore:${gatewayId}`);
      return { migrationId: "mig-op-1", slug, restored: true, steps: [] };
    }) as MigrationClient["restoreTarget"],
    resume: vi.fn(async () => undefined),
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
    resolveTargetPlacement: vi.fn(async () => ({ ok: true as const, release: 2, gatewayClass: "shared" as const })),
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
    findPreemptedComputer: vi.fn(async () => null),
    genMigrationId: (operationId: string) => `mig-${operationId}`,
    now: vi.fn(() => 5_000),
    sleep: vi.fn(async () => undefined),
    log: vi.fn(),
  };
  const steps: OperationStep[] = [];
  const ctx: OperationContext = {
    persistSchedulerHandoff: vi.fn(async () => undefined),
    persistCutoverCommitted: vi.fn(async (at: number) => {
      events.push(`cutover-recorded:${at}`);
    }),
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
  function nativeReturn(h: ReturnType<typeof mkDeps>) {
    const native = { checkpointRequested: false, checkpoint: vi.fn(async () => {}), release: vi.fn(async () => {}), isSourceFencedOff: vi.fn(async () => false) };
    h.deps.prepareNativeComputerReturn = vi.fn(async () => native);
    return native;
  }

  it("joins Shared channel readiness after source cleanup without starting a competing restore", async () => {
    const h = mkDeps();
    const native = nativeReturn(h);
    const order: string[] = [];
    native.checkpoint.mockImplementation(async () => { order.push("checkpoint"); });
    const verify = h.client.verifyTarget;
    h.client.verifyTarget = vi.fn(async (input) => {
      order.push("verify");
      expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-blue" }));
      return verify(input);
    });
    vi.mocked(h.deps.commitCutover).mockImplementation(async () => { order.push("cutover"); });
    native.release.mockImplementation(async () => { order.push("release"); });

    expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
    expect(order).toEqual(["checkpoint", "cutover", "release", "verify"]);
    expect(h.client.restoreTarget).not.toHaveBeenCalled();
    expect(h.client.transferState).not.toHaveBeenCalled();
    expect(h.deps.readGatewayOpenclawVersion).not.toHaveBeenCalled();
    expect(h.deps.readGatewayReleaseArtifact).not.toHaveBeenCalled();
  });

  describe("interrupted Shared mount recovery", () => {
    const missingMarker = {
      migrationId: "mig-op-1", slug: "alice", ready: false,
      checks: { customerDir: true, coachWired: true, mountMarked: false, accountHealthy: true },
    };
    const operation = () => mkOp({ cutoverCommittedAt: 100, input: {
      uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease",
    } });
    function recovery() {
      const h = mkDeps({ sourceGatewayId: "gw-green" });
      nativeReturn(h);
      h.ctx.assertActiveClaim = vi.fn(async () => undefined);
      h.ctx.withCustomerRestoreFence = vi.fn(async (_input, work) => work());
      h.ctx.assertCustomerRestoreSettled = vi.fn(async () => undefined);
      vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 1, epoch: 7 });
      vi.mocked(h.deps.readUserSnapshot).mockResolvedValue({ ...SNAPSHOT, gatewayId: "gw-green" });
      vi.mocked(h.client.verifyTarget).mockRejectedValueOnce(new MigrationRpcError("incomplete mount", {
        status: 409, details: missingMarker,
      }));
      return h;
    }

    it("holds an assignment fence while restoring the interrupted mount before verifying again", async () => {
      const h = recovery();
      vi.mocked(h.client.restoreTarget).mockImplementation(async (request) => {
        expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-blue" }));
        expect(h.ctx.assertActiveClaim).toHaveBeenCalled();
        return { migrationId: request.migrationId, slug: request.slug, restored: true, steps: ["verify-channel-ready"] };
      });
      expect(await createMigrateCustomerHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: true });
      expect(h.client.restoreTarget).toHaveBeenCalledWith({
        migrationId: "mig-op-1", gatewayId: "gw-green", uid: "uid-alice", slug: "alice",
        snapshot: { ...SNAPSHOT, gatewayId: "gw-green" },
      });
      expect(h.client.verifyTarget).toHaveBeenCalledTimes(2);
      expect(h.ctx.withCustomerRestoreFence).toHaveBeenCalledWith({
        uid: "uid-alice", slug: "alice", gatewayId: "gw-green", fromGatewayId: "gw-blue", assignmentEpoch: 7,
      }, expect.any(Function));
      expect(h.steps).toContainEqual(expect.objectContaining({ name: "restore-target", status: "done" }));
      expect(h.client.transferState).not.toHaveBeenCalled();
      expect(h.deps.commitCutover).not.toHaveBeenCalled();
    });

    it("never dispatches restore without durable coordination", async () => {
      const h = recovery();
      delete h.ctx.withCustomerRestoreFence;
      expect(await createMigrateCustomerHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false });
      expect(h.client.restoreTarget).not.toHaveBeenCalled();
    });

    it("does not accept ready state after an ambiguous earlier restore", async () => {
      const h = recovery();
      const native = nativeReturn(h);
      vi.mocked(h.client.verifyTarget).mockReset().mockResolvedValue({
        migrationId: "mig-op-1", slug: "alice", ready: true,
        checks: { customerDir: true, coachWired: true, mountMarked: true, accountHealthy: true },
      });
      vi.mocked(h.ctx.assertCustomerRestoreSettled!).mockRejectedValue(new Error("restore delivery remains ambiguous"));
      expect(await createMigrateCustomerHandler(h.deps)(operation(), h.ctx)).toMatchObject({
        success: false, error: expect.stringContaining("ambiguous"),
      });
      expect(h.client.verifyTarget).not.toHaveBeenCalled();
      expect(h.client.restoreTarget).not.toHaveBeenCalled();
      expect(native.release).not.toHaveBeenCalled();
      expect(h.client.unmount).not.toHaveBeenCalled();
      expect(h.client.scheduler).not.toHaveBeenCalled();
    });

    it("does not dispatch when placement or suspension wins the fence transaction", async () => {
      const h = recovery();
      vi.mocked(h.ctx.withCustomerRestoreFence!).mockRejectedValue(new Error("restore assignment changed"));
      expect(await createMigrateCustomerHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false });
      expect(h.client.restoreTarget).not.toHaveBeenCalled();
    });

    it.each([
      null,
      { ...SNAPSHOT, gatewayId: "gw-other" },
      { ...SNAPSHOT, gatewayId: "gw-green", uid: "uid-other" },
      { ...SNAPSHOT, gatewayId: "gw-green", slug: "other" },
      { ...SNAPSHOT, gatewayId: "gw-green", status: "provisioning" as const },
    ])("refuses a snapshot that no longer proves the assigned complete owner: %j", async (snapshot) => {
      const h = recovery();
      vi.mocked(h.deps.readUserSnapshot).mockResolvedValue(snapshot);
      expect(await createMigrateCustomerHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, rolledBack: false });
      expect(h.client.restoreTarget).not.toHaveBeenCalled();
    });

    it.each([
      { ...missingMarker, migrationId: "another-operation" },
      { ...missingMarker, slug: "another-owner" },
      { ...missingMarker, checks: { ...missingMarker.checks, accountHealthy: false } },
      { ...missingMarker, checks: { ...missingMarker.checks, coachWired: false } },
      { ...missingMarker, checks: { ...missingMarker.checks, customerDir: false } },
      { ...missingMarker, configTransferMode: "configured-builder-system-config" },
      { ...missingMarker, code: "unknown" },
      { ...missingMarker, checks: { ...missingMarker.checks, mountMarked: "false" } },
      { ...missingMarker, checks: null },
      { error: "unauthorized" },
    ])("does not turn a different failure into mount recovery: %j", async (details) => {
      const h = recovery();
      vi.mocked(h.client.verifyTarget).mockReset().mockRejectedValue(new MigrationRpcError("not ready", { status: 409, details }));
      expect(await createMigrateCustomerHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, rolledBack: false });
      expect(h.client.restoreTarget).not.toHaveBeenCalled();
    });

    it("refuses recovery after losing the operation claim", async () => {
      const h = recovery();
      vi.mocked(h.ctx.assertActiveClaim!).mockRejectedValue(new Error("operation re-claimed"));
      expect(await createMigrateCustomerHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, error: expect.stringContaining("operation re-claimed") });
      expect(h.client.restoreTarget).not.toHaveBeenCalled();
    });

    it.each([
      { migrationId: "other", slug: "alice", restored: true, steps: [] },
      { migrationId: "mig-op-1", slug: "other", restored: true, steps: [] },
      { migrationId: "mig-op-1", slug: "alice", restored: false, steps: [] },
    ])("rejects an unconfirmed or mismatched restore receipt: %j", async (receipt) => {
      const h = recovery();
      vi.mocked(h.client.restoreTarget).mockResolvedValue(receipt);
      expect(await createMigrateCustomerHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, rolledBack: false });
      expect(h.client.verifyTarget).toHaveBeenCalledOnce();
    });

    it("does not report restored readiness after assignment changes during the RPC", async () => {
      const h = recovery();
      vi.mocked(h.deps.readUser).mockResolvedValueOnce({ slug: "alice", currentGatewayId: "gw-green" })
        .mockResolvedValue({ slug: "alice", currentGatewayId: "gw-other" });
      expect(await createMigrateCustomerHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, error: expect.stringContaining("owner changed") });
      expect(h.client.restoreTarget).toHaveBeenCalledOnce();
      expect(h.client.verifyTarget).toHaveBeenCalledOnce();
    });

    it("does not verify completion when the claim is lost during restore", async () => {
      const h = recovery();
      vi.mocked(h.ctx.assertActiveClaim!).mockResolvedValueOnce(undefined)
        .mockRejectedValue(new Error("operation re-claimed"));
      expect(await createMigrateCustomerHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, error: expect.stringContaining("operation re-claimed") });
      expect(h.client.restoreTarget).toHaveBeenCalledOnce();
      expect(h.client.verifyTarget).toHaveBeenCalledOnce();
    });

    it("leaves a busy restore pending without skipping verification or changing ownership", async () => {
      const h = recovery();
      vi.mocked(h.client.restoreTarget).mockRejectedValue(new Error("mount already in flight"));
      expect(await createMigrateCustomerHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("mount already in flight") });
      expect(h.client.verifyTarget).toHaveBeenCalledOnce();
      expect(h.steps).toContainEqual(expect.objectContaining({ name: "restore-target", status: "failed" }));
    });

    it("does not claim success when verification remains incomplete after restore", async () => {
      const h = recovery();
      vi.mocked(h.client.verifyTarget).mockRejectedValue(new MigrationRpcError("incomplete mount", { status: 409, details: missingMarker }));
      expect(await createMigrateCustomerHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, rolledBack: false });
      expect(h.client.restoreTarget).toHaveBeenCalledOnce();
      expect(h.client.verifyTarget).toHaveBeenCalledTimes(2);
    });
  });

  it("retries forward when Shared is still mounting without rolling back or declaring success", async () => {
    const h = mkDeps();
    nativeReturn(h);
    vi.mocked(h.client.verifyTarget).mockRejectedValue(new Error("status 409: coach not ready"));
    expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({
      success: false, rolledBack: false, error: expect.stringContaining("status 503"),
    });
    expect(h.deps.commitCutover).toHaveBeenCalledOnce();
    expect(h.client.unmount).not.toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-green" }));
    expect(h.deps.setAssignmentState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "serving" }));
  });

  function attachInProgress(): MigrationRpcError {
    return new MigrationRpcError("/verify/gw-green: 409 coach attaching", {
      status: 409,
      code: MIGRATION_VERIFY_COACH_ATTACH_IN_PROGRESS,
    });
  }

  it("waits out a coach attach Shared reports in progress instead of failing the return", async () => {
    const h = mkDeps();
    nativeReturn(h);
    const ready = h.client.verifyTarget;
    h.client.verifyTarget = vi.fn()
      .mockRejectedValueOnce(attachInProgress())
      .mockRejectedValueOnce(attachInProgress())
      .mockImplementation(ready);

    expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true, rolledBack: false });
    expect(h.client.verifyTarget).toHaveBeenCalledTimes(3);
    expect(h.deps.sleep).toHaveBeenCalledTimes(2);
    expect(h.steps.filter((step) => step.status === "failed")).toEqual([]);
  });

  it("stops waiting for an in-progress coach attach at the provisioner's attach deadline", async () => {
    const h = mkDeps();
    nativeReturn(h);
    let clock = 5_000;
    vi.mocked(h.deps.now).mockImplementation(() => clock);
    vi.mocked(h.deps.sleep).mockImplementation(async (ms: number) => { clock += ms; });
    vi.mocked(h.client.verifyTarget).mockRejectedValue(attachInProgress());

    expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({
      success: false, rolledBack: false, error: expect.stringContaining("native return completion pending"),
    });
    const slept = vi.mocked(h.deps.sleep).mock.calls.reduce((total, [ms]) => total + ms, 0);
    expect(slept).toBeGreaterThanOrEqual(ADD_CUSTOMER_DEADLINE_MS);
    expect(slept).toBeLessThan(ADD_CUSTOMER_DEADLINE_MS + 30_000);
  });

  it("fails promptly when Shared reports the coach unwired with no attach in progress", async () => {
    const h = mkDeps();
    nativeReturn(h);
    vi.mocked(h.client.verifyTarget).mockRejectedValue(
      new MigrationRpcError("/verify/gw-green: 409 coachWired:false", { status: 409 }),
    );

    expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({
      success: false, rolledBack: false, error: expect.stringContaining("coachWired:false"),
    });
    expect(h.client.verifyTarget).toHaveBeenCalledOnce();
    expect(h.deps.sleep).not.toHaveBeenCalled();
  });

  it("keeps the return incomplete when source cleanup fails", async () => {
    const h = mkDeps();
    nativeReturn(h);
    vi.mocked(h.client.unmount).mockRejectedValue(new Error("source unreachable"));
    const result = await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("source unreachable");
    expect(result.rolledBack).toBe(false);
    expect(h.client.verifyTarget).not.toHaveBeenCalled();
    expect(h.deps.setAssignmentState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "serving" }));
  });

  it("finishes a cutover after Compute proves the lost source is stopped", async () => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    const native = { ...nativeReturn(h), isSourceFencedOff: vi.fn(async () => true) };
    h.deps.prepareNativeComputerReturn = vi.fn(async () => native);
    vi.mocked(h.deps.resolveGatewayUrl).mockImplementation(async (id) => {
      if (id === "gw-blue") throw new Error("source VM disappeared");
      return `http://${id}:18789`;
    });
    const result = await createMigrateCustomerHandler(h.deps)(mkOp({ input: {
      uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease",
    } }), h.ctx);
    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(native.isSourceFencedOff).toHaveBeenCalledOnce();
    expect(h.client.verifyTarget).toHaveBeenCalledOnce();
  });

  it.each([false, true])("checkpoints native state before Shared cutover (resumed=%s)", async (requested) => {
    const { deps, ctx, client, events } = mkDeps();
    const native = {
      checkpointRequested: requested,
      checkpoint: vi.fn(async () => { events.push("native-checkpoint"); }),
      release: vi.fn(async () => {}),
      isSourceFencedOff: vi.fn(async () => false),
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
    const native = { checkpointRequested: true, checkpoint: vi.fn(), release: vi.fn(async () => {}), isSourceFencedOff: vi.fn(async () => false) };
    deps.prepareNativeComputerReturn = vi.fn(async () => native);
    const result = await createMigrateCustomerHandler(deps)(mkOp({ input: {
      uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease",
    } }), ctx);
    expect(result.success).toBe(true);
    expect(native.release).toHaveBeenCalledOnce();
    expect(client.unmount).toHaveBeenCalledOnce();
    expect(client.flushGateway).not.toHaveBeenCalled();
    expect(native.checkpoint).not.toHaveBeenCalled();
    expect(client.verifyTarget).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-green" }));
  });

  it("does not report a recovered cutover complete while the destination is unavailable", async () => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    nativeReturn(h);
    vi.mocked(h.client.verifyTarget).mockRejectedValue(new Error("not connected"));
    const result = await createMigrateCustomerHandler(h.deps)(mkOp({ input: {
      uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease",
    } }), h.ctx);
    expect(result).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("not connected") });
  });

  it("rolls forward after an uncertain cutover response when Shared already owns the Builder", async () => {
    const { deps, ctx, client } = mkDeps();
    const native = { checkpointRequested: false, checkpoint: vi.fn(async () => {}), release: vi.fn(async () => {}), isSourceFencedOff: vi.fn(async () => false) };
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
      isSourceFencedOff: vi.fn(async () => false),
    };
    deps.prepareNativeComputerReturn = vi.fn(async () => native);
    const result = await createMigrateCustomerHandler(deps)(mkOp({}), ctx);
    expect(result).toMatchObject({ success: false, rolledBack: true, error: "checkpoint timed out" });
    expect(deps.commitCutover).not.toHaveBeenCalled();
    expect(client.unmount).not.toHaveBeenCalled();
    expect(native.release).toHaveBeenCalledOnce();
    expect(deps.setAssignmentState).toHaveBeenLastCalledWith(expect.objectContaining({ state: "serving" }));
  });

  describe("partial scheduler handoff", () => {
    const handoffId = "mig-op-1:scheduler:1";
    const schedulerCalls = (h: ReturnType<typeof mkDeps>) =>
      vi.mocked(h.client.scheduler).mock.calls.map(([request]) => [request.gatewayId, request.phase, request.retainNonportable]);

    it("moves portable schedules to Shared and leaves host-bound jobs dormant on the computer", async () => {
      const h = mkDeps();
      nativeReturn(h);
      const order: string[] = [];
      const snapshot = { version: 1, operationId: handoffId, agentIds: ["octogee-alice-coach"], jobs: [], scratch: [], retainedJobIds: ["desktop-watch"] };
      vi.mocked(h.client.quiesce).mockImplementation(async (request) => {
        order.push(`quiesce:${request.gatewayId}`);
        expect(h.ctx.persistSchedulerHandoff).toHaveBeenCalledWith({ migrationId: handoffId, fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" });
        return { migrationId: "mig-op-1", slug: "alice", drained: true, runningCount: 0 };
      });
      vi.mocked(h.client.scheduler).mockImplementation(async ({ gatewayId, phase, migrationId }) => {
        order.push(`${gatewayId}:${phase}`);
        return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot };
      });
      vi.mocked(h.deps.commitCutover).mockImplementation(async () => { order.push("cutover"); });
      vi.mocked(h.client.unmount).mockImplementation(async ({ gatewayId, slug }) => {
        order.push(`unmount:${gatewayId}`);
        return { migrationId: "mig-op-1", slug, unmounted: true };
      });

      expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
      expect(order).toEqual(["quiesce:gw-blue", "gw-blue:export", "gw-green:stage", "cutover", "gw-blue:retire", "gw-green:activate", "unmount:gw-blue"]);
      expect(vi.mocked(h.client.quiesce).mock.calls[0][0]).toMatchObject({ schedulerHandoff: true, schedulerMigrationId: handoffId, retainNonportable: true });
      expect(schedulerCalls(h)).toEqual([
        ["gw-blue", "export", true], ["gw-green", "stage", undefined], ["gw-blue", "retire", undefined], ["gw-green", "activate", undefined],
      ]);
      expect(vi.mocked(h.client.scheduler).mock.calls[1][0]).toMatchObject({ migrationId: handoffId, agentIds: ["octogee-alice-coach"], snapshot });
      expect(h.steps.filter((step) => step.status === "done").map((step) => step.name)).toEqual([
        "quiesce-source", "flush-source", "stage-scheduler", "checkpoint-native-computer", "cutover-firestore", "activate-scheduler", "unmount-source", "verify-target",
      ]);
      expect(vi.mocked(h.deps.log).mock.calls.flat().join("\n")).toContain("desktop-watch");
    });

    it("aborts Shared's staged schedules and reopens the computer's scheduler when the checkpoint fails", async () => {
      const h = mkDeps();
      const native = nativeReturn(h);
      native.checkpoint.mockRejectedValue(new Error("checkpoint timed out"));
      const order: string[] = [];
      vi.mocked(h.client.scheduler).mockImplementation(async ({ gatewayId, phase, migrationId }) => {
        order.push(`${gatewayId}:${phase}`);
        return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: { retainedJobIds: [] } };
      });
      vi.mocked(h.client.resume).mockImplementation(async () => { order.push("resume-ingress"); });

      expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: false, rolledBack: true, error: "checkpoint timed out" });
      expect(order).toEqual(["gw-blue:export", "gw-green:stage", "gw-green:abort", "gw-blue:resume", "resume-ingress"]);
      expect(h.deps.setAssignmentState).toHaveBeenLastCalledWith(expect.objectContaining({ state: "serving" }));
    });

    it("does not report a rollback while the computer's scheduler fence is unconfirmed", async () => {
      const h = mkDeps();
      const native = nativeReturn(h);
      native.checkpoint.mockRejectedValue(new Error("checkpoint timed out"));
      vi.mocked(h.client.scheduler).mockImplementation(async ({ phase, migrationId }) => {
        if (phase === "resume") throw new Error("computer unreachable");
        return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: { retainedJobIds: [] } };
      });

      const result = await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx);
      expect(result).toMatchObject({ success: false, rolledBack: false });
      expect(result.error).toContain("checkpoint timed out");
      expect(result.error).toContain("computer unreachable");
      expect(h.client.resume).toHaveBeenCalledOnce();
    });

    it("keeps the return pending while the computer's schedules are not retired", async () => {
      const h = mkDeps();
      nativeReturn(h);
      vi.mocked(h.client.scheduler).mockImplementation(async ({ phase, migrationId }) => {
        if (phase === "retire") throw new Error("computer unreachable");
        return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: { retainedJobIds: [] } };
      });

      expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("computer unreachable") });
      expect(schedulerCalls(h).map(([, phase]) => phase)).not.toContain("activate");
      expect(h.client.unmount).not.toHaveBeenCalled();
      expect(h.deps.commitCutover).toHaveBeenCalledOnce();
    });

    it("activates Shared's schedules once Compute proves the lost computer is stopped", async () => {
      const h = mkDeps();
      const native = nativeReturn(h);
      native.isSourceFencedOff.mockResolvedValue(true);
      vi.mocked(h.client.scheduler).mockImplementation(async ({ phase, migrationId }) => {
        if (phase === "retire") throw new Error("computer unreachable");
        return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: { retainedJobIds: [] } };
      });

      expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
      expect(schedulerCalls(h).map(([, phase]) => phase)).toEqual(["export", "stage", "retire", "activate"]);
      expect(vi.mocked(h.deps.log).mock.calls.flat().join("\n")).toContain(handoffId);
    });

    it("finishes the scheduler handoff when a retry finds the native return already cut over", async () => {
      const h = mkDeps({ sourceGatewayId: "gw-green" });
      const native = nativeReturn(h);
      const handoff = { migrationId: handoffId, fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" };
      const order: string[] = [];
      vi.mocked(h.client.scheduler).mockImplementation(async ({ gatewayId, phase, migrationId }) => {
        order.push(`${gatewayId}:${phase}`);
        return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true };
      });
      vi.mocked(h.client.unmount).mockImplementation(async ({ gatewayId, slug }) => {
        order.push(`unmount:${gatewayId}`);
        return { migrationId: "mig-op-1", slug, unmounted: true };
      });

      expect(await createMigrateCustomerHandler(h.deps)(mkOp({ schedulerHandoff: handoff, attempts: 1, input: {
        uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease",
      } }), h.ctx)).toMatchObject({ success: true });
      expect(order).toEqual(["gw-blue:retire", "gw-green:activate", "unmount:gw-blue"]);
      expect(native.release).toHaveBeenCalledOnce();
      expect(h.client.verifyTarget).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-green" }));
      expect(h.client.transferState).not.toHaveBeenCalled();
    });

    it("re-exports portable schedules under a fresh handoff when a restart resumes a claimed checkpoint", async () => {
      const h = mkDeps();
      const native = nativeReturn(h);
      native.checkpointRequested = true;
      const previous = { migrationId: handoffId, fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" };
      const retried = "mig-op-1:scheduler:2";
      const order: string[] = [];
      vi.mocked(h.client.quiesce).mockImplementation(async (request) => {
        order.push(`quiesce:${request.gatewayId}:${request.schedulerMigrationId}:${request.retainNonportable}`);
        return { migrationId: "mig-op-1", slug: "alice", drained: true, runningCount: 0 };
      });
      vi.mocked(h.client.scheduler).mockImplementation(async ({ gatewayId, phase, migrationId }) => {
        order.push(`${gatewayId}:${phase}:${migrationId}`);
        return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: { retainedJobIds: [] } };
      });
      vi.mocked(h.deps.commitCutover).mockImplementation(async () => { order.push("cutover"); });

      expect(await createMigrateCustomerHandler(h.deps)(mkOp({ schedulerHandoff: previous, attempts: 1 }), h.ctx)).toMatchObject({ success: true });
      expect(order).toEqual([
        `gw-green:abort:${handoffId}`, `gw-blue:resume:${handoffId}`,
        `quiesce:gw-blue:${retried}:true`, `gw-blue:export:${retried}`, `gw-green:stage:${retried}`,
        "cutover", `gw-blue:retire:${retried}`, `gw-green:activate:${retried}`,
      ]);
      expect(h.ctx.persistSchedulerHandoff).toHaveBeenCalledWith({ ...previous, migrationId: retried });
      expect(h.client.flushGateway).not.toHaveBeenCalled();
      expect(native.checkpoint).toHaveBeenCalledOnce();
    });
  });
});

describe("migrate-customer — Builder computer activation", () => {
  it("stages Shared's schedules beside the jobs a partial return left dormant on the computer", async () => {
    const h = mkDeps();
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 2, gatewayClass: "builder" });

    expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
    const stage = vi.mocked(h.client.scheduler).mock.calls.map(([request]) => request).find((request) => request.phase === "stage");
    expect(stage).toMatchObject({ gatewayId: "gw-green", retainNonportable: true });
    expect(vi.mocked(h.client.scheduler).mock.calls.map(([request]) => request).filter((request) => request.phase !== "stage")
      .every((request) => request.retainNonportable === undefined)).toBe(true);
    expect(vi.mocked(h.client.quiesce).mock.calls[0][0].retainNonportable).toBeUndefined();
  });

  it("stages onto a Shared target with today's strict conflict rules", async () => {
    const h = mkDeps();
    expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
    const stage = vi.mocked(h.client.scheduler).mock.calls.map(([request]) => request).find((request) => request.phase === "stage");
    expect(stage?.retainNonportable).toBeUndefined();
  });
});

describe("migrate-customer — Builder activation onto a held computer", () => {
  const HELD = '/scheduler/gw-green: 500 {"error":"scheduler migration failed","message":"OpenClaw workspace identities are not initialized for this boot"}';
  const deferred = {
    migrationId: "mig-op-1:scheduler:1", fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice",
    stageAfterCutover: true as const,
  };

  function heldActivation(options: { sourceGatewayId?: string } = {}) {
    const h = mkDeps(options);
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 2, gatewayClass: "builder" });
    let cutOver = options.sourceGatewayId === "gw-green";
    const order: string[] = [];
    vi.mocked(h.client.schedulerReady).mockImplementation(async () => {
      if (!cutOver) throw new Error(HELD.replace("/scheduler/", "/scheduler-ready/"));
    });
    vi.mocked(h.client.scheduler).mockImplementation(async ({ migrationId, phase, gatewayId, retainNonportable }) => {
      if (gatewayId === "gw-green" && !cutOver) throw new Error(HELD);
      order.push(`${gatewayId}:${phase}:${migrationId}${retainNonportable ? ":retain" : ""}`);
      return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: { retainedJobIds: [] } };
    });
    vi.mocked(h.deps.commitCutover).mockImplementation(async () => { cutOver = true; order.push("cutover"); });
    vi.mocked(h.ctx.persistSchedulerHandoff!).mockImplementation(async (state) => { order.push(`persist:${JSON.stringify(state)}`); });
    return { ...h, order };
  }

  it("records the handoff as staged after cutover, then stages Shared's schedules on the released computer", async () => {
    const h = heldActivation();

    expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });

    const id = deferred.migrationId;
    expect(h.order).toEqual([
      `persist:${JSON.stringify(deferred)}`,
      `gw-blue:export:${id}`, "cutover", `gw-green:stage:${id}:retain`,
      `persist:${JSON.stringify({ ...deferred, stagedAt: 5_000 })}`,
      `gw-blue:retire:${id}`, `gw-green:activate:${id}`,
    ]);
    expect(h.client.schedulerReady).not.toHaveBeenCalled();
  });

  it("keeps a Shared target's handoff staged before cutover", async () => {
    const h = mkDeps();
    expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
    expect(h.ctx.persistSchedulerHandoff).toHaveBeenCalledTimes(1);
    expect(h.ctx.persistSchedulerHandoff).toHaveBeenCalledWith({
      migrationId: "mig-op-1:scheduler:1", fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice",
    });
  });

  it("stages from the source's exported copy when a retry finds the cutover committed but nothing staged", async () => {
    const h = heldActivation({ sourceGatewayId: "gw-green" });

    expect(await createMigrateCustomerHandler(h.deps)(mkOp({ schedulerHandoff: deferred, attempts: 1, cutoverCommittedAt: 4_000 }), h.ctx))
      .toMatchObject({ success: true });

    const id = deferred.migrationId;
    expect(h.order).toEqual([
      `gw-blue:export:${id}`, `gw-green:stage:${id}:retain`,
      `persist:${JSON.stringify({ ...deferred, stagedAt: 5_000 })}`,
      `gw-blue:retire:${id}`, `gw-green:activate:${id}`,
    ]);
    expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-blue" }));
  });

  it("does not re-export once the post-cutover stage is recorded", async () => {
    const h = heldActivation({ sourceGatewayId: "gw-green" });

    expect(await createMigrateCustomerHandler(h.deps)(mkOp({ schedulerHandoff: { ...deferred, stagedAt: 4_500 }, attempts: 1 }), h.ctx))
      .toMatchObject({ success: true });

    expect(h.order).toEqual([`gw-blue:retire:${deferred.migrationId}`, `gw-green:activate:${deferred.migrationId}`]);
  });

  it("keeps the handoff pending, retryably, while the released computer's scheduler is not ready", async () => {
    const h = heldActivation({ sourceGatewayId: "gw-green" });
    vi.mocked(h.client.scheduler).mockImplementation(async ({ migrationId, phase, gatewayId }) => {
      if (gatewayId === "gw-green") throw new Error(HELD);
      return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: {} };
    });

    const result = await createMigrateCustomerHandler(h.deps)(mkOp({ schedulerHandoff: deferred, attempts: 1 }), h.ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(classifyOperationFailure(result.error)).toBe("transient");
    expect(vi.mocked(h.client.scheduler).mock.calls.map(([request]) => request.phase)).not.toContain("retire");
    expect(h.client.unmount).not.toHaveBeenCalled();
  });

  it("resumes only the source when a retry follows a pre-cutover failure: the held computer never received anything", async () => {
    const h = heldActivation();

    expect(await createMigrateCustomerHandler(h.deps)(mkOp({ schedulerHandoff: deferred, attempts: 1 }), h.ctx)).toMatchObject({ success: true });

    expect(h.order[0]).toBe(`gw-blue:resume:${deferred.migrationId}`);
    expect(h.order.filter((call) => call.includes(`:${deferred.migrationId}`))).toEqual([`gw-blue:resume:${deferred.migrationId}`]);
  });

  it("retries, never fails terminally, when a staged attempt's target cannot yet abort it", async () => {
    const h = mkDeps();
    const previous = { migrationId: "mig-op-1:scheduler:1", fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" };
    vi.mocked(h.client.scheduler).mockImplementation(async ({ gatewayId, phase }) => {
      if (gatewayId === "gw-green" && phase === "abort") throw new Error(HELD);
      throw new Error(`unexpected ${gatewayId}:${phase}`);
    });

    const result = await createMigrateCustomerHandler(h.deps)(mkOp({ schedulerHandoff: previous, attempts: 1 }), h.ctx);

    expect(result.success).toBe(false);
    expect(classifyOperationFailure(result.error)).toBe("transient");
    expect(h.client.quiesce).not.toHaveBeenCalled();
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

  it("records the committed cutover before source cleanup so the serial lock releases while cleanup runs", async () => {
    const { deps, ctx, client, events } = mkDeps();
    vi.mocked(client.unmount).mockImplementation(async ({ gatewayId, slug }) => {
      events.push(`unmount:${gatewayId}`);
      return { migrationId: "mig-op-1", slug, unmounted: true };
    });

    const result = await createMigrateCustomerHandler(deps)(mkOp({}), ctx);

    expect(result).toMatchObject({ success: true });
    expect(events.slice(events.indexOf("cutover:gw-blue->gw-green:mirror=true"))).toEqual([
      "cutover:gw-blue->gw-green:mirror=true",
      "cutover-recorded:5000",
      "unmount:gw-blue",
    ]);
  });

  it("keeps the migration complete and the lock held when the cutover record cannot be written", async () => {
    const { deps, ctx, client } = mkDeps();
    vi.mocked(ctx.persistCutoverCommitted!).mockRejectedValue(new Error("journal unavailable"));

    const result = await createMigrateCustomerHandler(deps)(mkOp({}), ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(client.unmount).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.log).mock.calls.some(([message]) => /❌.*cutover.*journal unavailable/u.test(message))).toBe(true);
  });

  it("never re-drives a migration whose cutover already committed once the customer has moved on", async () => {
    const { deps, ctx, client, events } = mkDeps({ sourceGatewayId: "gw-purple" });
    const schedulerHandoff = { migrationId: "mig-op-1:scheduler:1", fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" };

    const result = await createMigrateCustomerHandler(deps)(mkOp({ schedulerHandoff, attempts: 1, cutoverCommittedAt: 4_000 }), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.error).toMatch(/cutover already committed to gw-green; customer now owned by gw-purple/u);
    expect(client.calls).toEqual([]);
    expect(client.scheduler).not.toHaveBeenCalled();
    expect(events.some((event) => event.startsWith("cutover:") || event.startsWith("assignment:"))).toBe(false);
  });

  it.each([false, true])("moves a Builder with an active scheduled run: the source's quiesce owns the hold, so a 409 hold never reaches the runner (durable=%s)", async (durable) => {
    const client = happyClient();
    vi.mocked(client.scheduler).mockImplementation(async ({ migrationId, phase }) => {
      if (phase === "hold") throw new Error("scheduler hold did not prove a drained matching operation");
      return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: {} };
    });
    const { deps, ctx, events } = mkDeps({ client, durable });

    const result = await createMigrateCustomerHandler(deps)(mkOp({}), ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(vi.mocked(client.scheduler).mock.calls.map(([request]) => request.phase)).not.toContain("hold");
    expect(vi.mocked(client.quiesce).mock.calls[0][0]).toMatchObject({ gatewayId: "gw-blue", schedulerHandoff: true });
    expect(events.some((event) => event.startsWith("cutover:") || event.startsWith("v2-cutover:"))).toBe(true);
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
      "initialized", "keysSynced", "sourceQuiesced",
      "finalSynced", "targetVerified", "cutover", "cutover", "sourceRetired", "complete",
    ]);
    expect(client.calls).toEqual([
      "transfer:keys:gw-blue->gw-green",
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

  it("moves a Builder onto a held computer: nothing reaches its scheduler until cutover releases it", async () => {
    const h = mkDeps({ durable: true });
    let cutOver = false;
    const order: string[] = [];
    vi.mocked(h.deps.commitV2Cutover).mockImplementation(async () => { cutOver = true; order.push("cutover"); });
    vi.mocked(h.client.scheduler).mockImplementation(async ({ migrationId, phase, gatewayId }) => {
      if (gatewayId === "gw-green" && !cutOver) {
        throw new Error('/scheduler/gw-green: 500 {"message":"OpenClaw workspace identities are not initialized for this boot"}');
      }
      order.push(`${gatewayId}:${phase}`);
      return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: {} };
    });

    expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });

    expect(order).toEqual(["gw-blue:export", "cutover", "gw-blue:export", "gw-green:stage", "gw-blue:retire", "gw-green:activate"]);
    expect(h.persisted.find((state) => state.phase === "cutover" && state.schedulerStagedAt !== undefined)).toBeDefined();
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
      "initialized", "keysSynced", "sourceQuiesced",
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
      "initialized", "keysSynced", "sourceQuiesced",
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
      persistSchedulerHandoff: vi.fn(async () => undefined),
    reportStep: vi.fn(async () => undefined),
      persistCustomerMigrationV2: vi.fn(async (state) => {
        persisted.push(state);
        if (state.phase === "keysSynced") cancelRequested = true;
      }),
      cancellationRequested: vi.fn(async () => cancelRequested),
    } as unknown as OperationContext;
    const handler = createMigrateCustomerHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.error).toMatch(/superseded/u);
    expect(deps.reportMigrationProgress).toHaveBeenCalledWith("gw-green", expect.objectContaining({ phase: "keysSynced", status: "skipped" }));
    expect(deps.reportMigrationProgress).toHaveBeenCalledWith("gw-green", expect.objectContaining({ phase: "abortIntent", status: "running" }));
    expect(persisted.map((state) => state.phase)).toContain("abortIntent");
    expect(client.calls.filter((call) => call.startsWith("unmount:"))).toEqual(["unmount:gw-green"]);
    expect(events).toContain("assignment:gw-blue:serving");
  });
});

describe("scheduler handoff recovery", () => {
  const schedulerHandoff = { migrationId: "mig-op-1:scheduler:1", fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" };

  it("persists its scheduler attempt before contacting the scheduler", async () => {
    const h = mkDeps();
    vi.mocked(h.client.scheduler).mockImplementation(async ({ migrationId, phase }) => {
      expect(h.ctx.persistSchedulerHandoff).toHaveBeenCalledWith(schedulerHandoff);
      return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: {} };
    });
    expect(await createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
  });

  it("recovers committed cutover with the persisted identity instead of copying state again", async () => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    expect(await createMigrateCustomerHandler(h.deps)(mkOp({ schedulerHandoff, attempts: 1 }), h.ctx)).toMatchObject({ success: true });
    expect(vi.mocked(h.client.scheduler).mock.calls.map(([request]) => [request.gatewayId, request.phase, request.migrationId])).toEqual([
      ["gw-blue", "retire", schedulerHandoff.migrationId], ["gw-green", "activate", schedulerHandoff.migrationId],
    ]);
    expect(h.client.transferState).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
    expect(h.client.resume).not.toHaveBeenCalled();
  });

  it("keeps committed cutover pending when source retirement is unconfirmed", async () => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    vi.mocked(h.client.scheduler).mockRejectedValue(new Error("timeout"));
    expect(await createMigrateCustomerHandler(h.deps)(mkOp({ schedulerHandoff }), h.ctx)).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("scheduler handoff cleanup pending") });
    expect(h.client.scheduler).toHaveBeenCalledTimes(1);
    expect(h.client.unmount).not.toHaveBeenCalled();
  });

  it("completes a cut-over handoff whose source unmount is refused on held agent files, leaving source cleanup to eviction", async () => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    const heldOpen = "/unmount/gw-blue: 500 {\"error\":\"unmount failed\",\"message\":\"agent database files are still held open: /home/node/.openclaw/agents/octogee-alice-coach/openclaw-agent.sqlite\"}";
    vi.mocked(h.client.unmount).mockRejectedValue(new Error(heldOpen));

    expect(await createMigrateCustomerHandler(h.deps)(mkOp({ schedulerHandoff, attempts: 6 }), h.ctx)).toMatchObject({ success: true, rolledBack: false });
    expect(vi.mocked(h.client.scheduler).mock.calls.map(([request]) => [request.gatewayId, request.phase])).toEqual([
      ["gw-blue", "retire"], ["gw-green", "activate"],
    ]);
    expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-blue", slug: "alice" }));
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringMatching(/unmount-source cleanup failed after durable cutover.*alice.*held open.*target remains serving/));
  });

  it("closes a failed scheduler attempt before reusing the customer on a new attempt", async () => {
    const h = mkDeps();
    expect(await createMigrateCustomerHandler(h.deps)(mkOp({ schedulerHandoff, attempts: 1 }), h.ctx)).toMatchObject({ success: true });
    expect(vi.mocked(h.client.scheduler).mock.calls.slice(0, 3).map(([request]) => [request.gatewayId, request.phase, request.migrationId])).toEqual([
      ["gw-green", "abort", schedulerHandoff.migrationId], ["gw-blue", "resume", schedulerHandoff.migrationId], ["gw-blue", "export", "mig-op-1:scheduler:2"],
    ]);
    expect(vi.mocked(h.client.quiesce).mock.calls[0][0]).toMatchObject({ schedulerHandoff: true, schedulerMigrationId: "mig-op-1:scheduler:2" });
  });

  it("finishes handoff cleanup for a migration whose serial lock was already released", async () => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    expect(await createMigrateCustomerHandler(h.deps)(mkOp({ schedulerHandoff, attempts: 1, cutoverCommittedAt: 4_000 }), h.ctx)).toMatchObject({ success: true });
    expect(vi.mocked(h.client.scheduler).mock.calls.map(([request]) => [request.gatewayId, request.phase])).toEqual([
      ["gw-blue", "retire"], ["gw-green", "activate"],
    ]);
    expect(h.client.unmount).toHaveBeenCalledTimes(1);
  });

  it("cannot start scheduling handoff when its durable identity cannot be saved", async () => {
    const h = mkDeps();
    vi.mocked(h.ctx.persistSchedulerHandoff!).mockRejectedValue(new Error("journal unavailable"));
    await expect(createMigrateCustomerHandler(h.deps)(mkOp({}), h.ctx)).rejects.toThrow("journal unavailable");
    expect(h.client.scheduler).not.toHaveBeenCalled();
  });
});

describe("migrate-customer — preempted computers", () => {
  const rsyncReset = "push-rsync-state: 500 rsync code=12 errno=104 Connection reset";

  function finalTransferFails(): MigrationClient & { calls: string[] } {
    const client = happyClient();
    const transfer = client.transferState as ReturnType<typeof vi.fn>;
    const happy = transfer.getMockImplementation()!;
    transfer.mockImplementation(async (request: { mode?: string }) => {
      if (request.mode === "final") throw Object.assign(new Error(rsyncReset), { status: 500 });
      return happy(request);
    });
    return client;
  }

  const activation = () => mkOp({
    id: "builder-activate-gw-green",
    startedAt: 7_000,
    firstStartedAt: 6_000,
    input: { uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease" },
  });

  it("rolls back as before but blames the target computer Compute preempted since the migration first started", async () => {
    const h = mkDeps({ durable: true, client: finalTransferFails() });
    (h.deps.findPreemptedComputer as ReturnType<typeof vi.fn>).mockImplementation(async (gatewayId: string) =>
      gatewayId === "gw-green" ? "octogee-pool-44847785" : null);

    const result = await createMigrateCustomerHandler(h.deps)(activation(), h.ctx);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.error).toBe(`target computer octogee-pool-44847785 was preempted: ${rsyncReset}`);
    expect(h.persisted.at(-1)?.phase).toBe("aborted");
    expect(h.events).toContain("assignment:gw-blue:serving");
    expect(h.deps.findPreemptedComputer).toHaveBeenCalledWith("gw-green", 6_000);
  });

  it("blames the source computer when the Builder's own computer was preempted mid-return", async () => {
    const h = mkDeps({ durable: true, client: finalTransferFails() });
    (h.deps.findPreemptedComputer as ReturnType<typeof vi.fn>).mockImplementation(async (gatewayId: string) =>
      gatewayId === "gw-blue" ? "octogee-computer-prod-uida" : null);

    const result = await createMigrateCustomerHandler(h.deps)(activation(), h.ctx);

    expect(result.error).toBe(`source computer octogee-computer-prod-uida was preempted: ${rsyncReset}`);
  });

  it("leaves the failure as it was when neither computer was preempted, and never asks on success", async () => {
    const failed = mkDeps({ durable: true, client: finalTransferFails() });
    const result = await createMigrateCustomerHandler(failed.deps)(activation(), failed.ctx);
    expect(result.error).toBe(rsyncReset);
    expect(failed.deps.findPreemptedComputer).toHaveBeenCalledTimes(2);

    const succeeded = mkDeps({ durable: true });
    await createMigrateCustomerHandler(succeeded.deps)(activation(), succeeded.ctx);
    expect(succeeded.deps.findPreemptedComputer).not.toHaveBeenCalled();
  });

  it("keeps the original failure and logs when Compute cannot say whether a computer was preempted", async () => {
    const h = mkDeps({ durable: true, client: finalTransferFails() });
    (h.deps.findPreemptedComputer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("http 403"));

    const result = await createMigrateCustomerHandler(h.deps)(activation(), h.ctx);

    expect(result.error).toBe(rsyncReset);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringMatching(/could not check whether gw-green's computer was preempted: http 403/));
  });
});
