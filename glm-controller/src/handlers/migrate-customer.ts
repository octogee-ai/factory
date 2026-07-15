import type {
  Operation,
  OperationStep,
  StepStatus,
} from "@octogee/shared/types/glm";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import {
  isDefinitiveConfigRpcRejection,
  type MigrationClient,
} from "@octogee/core/fleet-migration-client";
import type { PlacementResolution } from "@octogee/core/assignment-doc";
import type { RevisionSystemConfigObservation } from "@octogee/shared/types/gateway-releases";
import type { SystemConfigMigrationMode } from "@octogee/shared/types/fleet-controller";
import {
  runMigration,
  type ConfigCleanupObligation,
  type CutoverCommit,
  type MigrationRollFence,
  type MigrationRunnerDeps,
  type ReportedStep,
} from "@octogee/core/fleet-migration-runner";

// At most one migration per target gateway at a time (mirrors the
// fleet-migration-runner's one-slot-per-target transfer capacity). Enforced
// durably, before this handler ever runs, by the operation queue in index.ts
// (operation-queue.ts scopes migrate-customer exclusivity by toGatewayId); a
// conflicting request is queued there, not rejected here.

export interface UserGatewayInfo {
  slug: string;
  currentGatewayId: string;
}

export interface SourceRevision {
  revisionId: string;
  release: number;
  epoch?: number;
}

export interface MigrateCustomerDeps {

  readUser: (uid: string) => Promise<UserGatewayInfo | null>;

  readUserSnapshot: (uid: string) => Promise<FleetBrokerUserSnapshot | null>;

  commitCutover: (commit: CutoverCommit) => Promise<void>;

  resolveGatewayUrl: (revisionId: string) => Promise<string>;

  buildClient: (resolveSync: (revisionId: string) => string) => MigrationClient;

  resolveFromRevision: (uid: string, currentGatewayId: string) => Promise<SourceRevision | null>;
  resolvePlacement: (toGatewayId: string) => Promise<PlacementResolution | null>;

  setAssignmentState: (input: {
    gatewayId: string;
    uid: string;
    state: "serving" | "quiescing" | "migrating";
  }) => Promise<void>;

  assertRollFence: (fence: MigrationRollFence) => Promise<void>;

  recordConfigProof: (
    targetRevisionId: string,
    proof: RevisionSystemConfigObservation,
    rollFence: MigrationRollFence | null,
  ) => Promise<void>;

  recordConfigRollMetric: (input: {
    stage: "checkpoint" | "proof" | "unfreeze";
    result: "ok" | "fail";
    gatewayId: string;
    revisionId: string;
  }) => void;

  resolveSystemConfigMigrationMode: (
    fromGatewayId: string,
    toGatewayId: string,
  ) => Promise<SystemConfigMigrationMode>;

  assertSystemConfigProtocolReady: (input: {
    mode: SystemConfigMigrationMode;
    sourceGatewayId: string;
    sourceRevisionId: string;
    targetGatewayId: string;
    targetRevisionId: string;
  }) => Promise<void>;

  recoverConfigFreezeOwner: (input: {
    ownerMigrationId: string;
    requestedMigrationId: string;
    uid: string;
    slug: string;
    sourceGatewayId: string;
    sourceTransportId: string;
    targetGatewayId: string;
    targetTransportId: string;
    rollOperationId?: string;
  }) => Promise<boolean>;

  genMigrationId: (operationId: string) => string;

  now: () => number;
  log: (msg: string) => void;
}

interface MigrateCustomerInput {
  uid?: unknown;
  toGatewayId?: unknown;
  systemConfigMigrationMode?: unknown;
  source?: unknown;
  rollOperationId?: unknown;
}

function requestedSystemConfigMigrationMode(
  value: unknown,
): SystemConfigMigrationMode | null {
  if (value === undefined) return null;
  if (
    value === "none" ||
    value === "checkpoint-only" ||
    value === "checkpoint-and-restore"
  ) {
    return value;
  }
  throw new Error("invalid systemConfigMigrationMode in op.input");
}

function optionalCleanupRecord<T>(value: unknown): T | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid durable config cleanup obligation");
  }
  return value as T;
}

function configCleanupFromOutput(
  output: Record<string, unknown> | undefined,
): ConfigCleanupObligation | null {
  if (!output || !Object.prototype.hasOwnProperty.call(output, "configCleanup")) return null;
  const value = output?.configCleanup;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid durable config cleanup obligation");
  }
  const cleanup = value as Record<string, unknown>;
  const resumeValue = cleanup.resume;
  if (!resumeValue || typeof resumeValue !== "object" || Array.isArray(resumeValue)) {
    throw new Error("invalid durable config cleanup obligation");
  }
  const resume = resumeValue as Record<string, unknown>;
  if (
    typeof cleanup.migrationId !== "string" ||
    typeof cleanup.slug !== "string" ||
    typeof cleanup.sourceGatewayId !== "string" ||
    typeof cleanup.sourceTransportId !== "string" ||
    typeof resume.success !== "boolean" ||
    typeof resume.rolledBack !== "boolean" ||
    (resume.error !== undefined && typeof resume.error !== "string")
  ) {
    throw new Error("invalid durable config cleanup obligation");
  }
  const configCheckpoint = optionalCleanupRecord<
    ConfigCleanupObligation["resume"]["configCheckpoint"]
  >(resume.configCheckpoint);
  const configProof = optionalCleanupRecord<
    ConfigCleanupObligation["resume"]["configProof"]
  >(resume.configProof);
  return {
    migrationId: cleanup.migrationId,
    slug: cleanup.slug,
    sourceGatewayId: cleanup.sourceGatewayId,
    sourceTransportId: cleanup.sourceTransportId,
    completeSourceUnmount: cleanup.completeSourceUnmount === true,
    resume: {
      success: resume.success,
      rolledBack: resume.rolledBack,
      ...(typeof resume.error === "string" ? { error: resume.error } : {}),
      ...(configCheckpoint ? { configCheckpoint } : {}),
      ...(configProof ? { configProof } : {}),
    },
  };
}

function resumedConfigOutput(
  cleanup: ConfigCleanupObligation,
): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  if (cleanup.resume.configCheckpoint) output.configCheckpoint = cleanup.resume.configCheckpoint;
  if (cleanup.resume.configProof) output.configProof = cleanup.resume.configProof;
  return Object.keys(output).length > 0 ? output : undefined;
}

async function resumeConfigCleanup(
  deps: MigrateCustomerDeps,
  ctx: OperationContext,
  cleanup: ConfigCleanupObligation,
): Promise<OperationResult> {
  const startedAt = deps.now();
  await ctx.reportStep({ name: "unfreeze-config", status: "running", startedAt });
  try {
    const sourceUrl = await deps.resolveGatewayUrl(cleanup.sourceTransportId);
    const client = deps.buildClient((transportId) => {
      if (transportId !== cleanup.sourceTransportId) {
        throw new Error(`cleanup client called with unexpected gatewayId: ${transportId}`);
      }
      return sourceUrl;
    });
    const response = await client.unfreezeConfig({
      migrationId: cleanup.migrationId,
      gatewayId: cleanup.sourceGatewayId,
      transportId: cleanup.sourceTransportId,
      slug: cleanup.slug,
    });
    if (response.unfrozen !== true) throw new Error("config unfreeze was not confirmed");
    await ctx.reportStep({
      name: "unfreeze-config",
      status: "done",
      completedAt: deps.now(),
    });
    deps.recordConfigRollMetric({
      stage: "unfreeze",
      result: "ok",
      gatewayId: cleanup.sourceGatewayId,
      revisionId: cleanup.sourceTransportId,
    });
    if (cleanup.completeSourceUnmount) {
      try {
        await ctx.reportStep({
          name: "unmount-source-cleanup",
          status: "running",
          startedAt: deps.now(),
        });
        await client.unmount({
          migrationId: cleanup.migrationId,
          gatewayId: cleanup.sourceGatewayId,
          transportId: cleanup.sourceTransportId,
          slug: cleanup.slug,
        });
        await ctx.reportStep({
          name: "unmount-source-cleanup",
          status: "done",
          completedAt: deps.now(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await ctx.reportStep({
          name: "unmount-source-cleanup",
          status: "skipped",
          completedAt: deps.now(),
          error: message,
        });
        deps.log(`[migrate-customer] source unmount cleanup remains pending: ${message}`);
        return {
          steps: [],
          success: false,
          error: isDefinitiveConfigRpcRejection(error)
            ? `config cleanup terminal: ${message}`
            : `source unmount cleanup pending: ${message}`,
          rolledBack: cleanup.resume.rolledBack,
          output: { configCleanup: cleanup },
        };
      }
    }
    const output = resumedConfigOutput(cleanup);
    return {
      steps: [],
      success: cleanup.resume.success,
      rolledBack: cleanup.resume.rolledBack,
      ...(!cleanup.resume.success && cleanup.resume.error ? { error: cleanup.resume.error } : {}),
      ...(output ? { output } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reportStep({
      name: "unfreeze-config",
      status: "skipped",
      completedAt: deps.now(),
      error: message,
    });
    deps.recordConfigRollMetric({
      stage: "unfreeze",
      result: "fail",
      gatewayId: cleanup.sourceGatewayId,
      revisionId: cleanup.sourceTransportId,
    });
    return {
      steps: [],
      success: false,
      error: isDefinitiveConfigRpcRejection(error)
        ? `config cleanup terminal: ${message}`
        : `config unfreeze cleanup pending: ${message}`,
      rolledBack: cleanup.resume.rolledBack,
      output: { configCleanup: cleanup },
    };
  }
}

function reportedStatusToStepStatus(reported: ReportedStep["status"]): StepStatus {
  if (reported === "running") return "running";
  if (reported === "done") return "done";
  if (reported === "skipped") return "skipped";
  return "failed";
}

function reportedToOperationStep(rep: ReportedStep, now: number): OperationStep {
  const status = reportedStatusToStepStatus(rep.status);
  const step: OperationStep = { name: rep.name, status };
  if (rep.status === "running") step.startedAt = now;
  else step.completedAt = now;
  if (rep.error) step.error = rep.error;
  return step;
}

interface MigrationTargets {
  toGatewayId: string;
  fromGatewayId: string;
  toRevisionId: string;
  toRelease: number | null;
  fromRevisionId: string;
  fromRelease: number;
  fromEpoch: number;
  fromTransportId: string;
  toTransportId: string;
}

function alreadyOnTargetError(
  fromRevisionId: string,
  toRevisionId: string,
): string | null {
  return fromRevisionId === toRevisionId ? `customer already on ${toRevisionId}` : null;
}

async function resolveToRevision(
  deps: MigrateCustomerDeps,
  toGatewayId: string,
): Promise<{ revisionId: string; release: number | null } | { error: string }> {
  const placement = await deps.resolvePlacement(toGatewayId);
  if (placement === null) {
    return { error: `target gateway ${toGatewayId} has no durable placement` };
  }
  if (placement.ok === false) {
    return { error: `placement rejected for ${toGatewayId}: ${placement.reason}` };
  }
  return {
    revisionId: placement.revisionId,
    release: placement.release,
  };
}

async function resolveMigrationTargets(
  deps: MigrateCustomerDeps,
  uid: string,
  user: UserGatewayInfo,
  toGatewayId: string,
): Promise<{ targets: MigrationTargets } | { error: string }> {
  const fromRevision = await deps.resolveFromRevision(uid, user.currentGatewayId);
  if (!fromRevision) {
    return {
      error: `source gateway ${user.currentGatewayId} has no durable revision`,
    };
  }
  const to = await resolveToRevision(deps, toGatewayId);
  if ("error" in to) return { error: to.error };

  const rejected = alreadyOnTargetError(fromRevision.revisionId, to.revisionId);
  if (rejected) return { error: rejected };

  return {
    targets: {
      toGatewayId,
      fromGatewayId: user.currentGatewayId,
      toRevisionId: to.revisionId,
      toRelease: to.release,
      fromRevisionId: fromRevision.revisionId,
      fromRelease: fromRevision.release,
      fromEpoch: fromRevision.epoch ?? 0,
      fromTransportId: fromRevision.revisionId,
      toTransportId: to.revisionId,
    },
  };
}

function buildRunnerDeps(
  deps: MigrateCustomerDeps,
  client: MigrationClient,
  ctx: OperationContext,
  targetRevisionId: string,
  observedAt: () => number,
  targets: MigrationTargets,
  rollFence: MigrationRollFence | null,
): MigrationRunnerDeps {
  const runnerDeps: MigrationRunnerDeps = {
    client,
    commitCutover: deps.commitCutover,
    log: deps.log,
    reportStep: async (rep: ReportedStep) => {
      const step = reportedToOperationStep(rep, deps.now());
      await ctx.reportStep(step);
      const metricStage = rep.name === "freeze-config"
        ? "checkpoint"
        : rep.name === "prove-config-restore"
          ? "proof"
          : rep.name === "unfreeze-config"
            ? "unfreeze"
            : null;
      if (metricStage && rep.status !== "running") {
        const targetMetric = metricStage === "proof";
        deps.recordConfigRollMetric({
          stage: metricStage,
          result: rep.status === "done" ? "ok" : "fail",
          gatewayId: targetMetric ? targets.toGatewayId : targets.fromGatewayId,
          revisionId: targetMetric ? targets.toRevisionId : targets.fromRevisionId,
        });
      }
    },
  };
  runnerDeps.setAssignmentState = deps.setAssignmentState;
  runnerDeps.recoverConfigFreezeOwner = deps.recoverConfigFreezeOwner;
  runnerDeps.acceptConfigProof = async ({
    migrationId,
    slug,
    sourceRevisionId,
    checkpoint,
    proof,
  }) => deps.recordConfigProof(
    targetRevisionId,
    {
      migrationId,
      builderSlug: slug,
      sourceRevisionId,
      checkpointCommit: checkpoint.checkpointCommit,
      restoredCommit: proof.restoredCommit,
      acceptedCommit: proof.acceptedCommit,
      configHash: proof.configHash,
      configReady: proof.configReady,
      observedRevisionId: proof.observedRevisionId,
      restoreProvenAt: proof.restoreProvenAt,
      configReadyAt: proof.configReadyAt,
      runtimeConfigHash: proof.runtimeConfigHash,
      observedAt: observedAt(),
    },
    rollFence,
  );
  return runnerDeps;
}

export function createMigrateCustomerHandler(deps: MigrateCustomerDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    let cleanup: ConfigCleanupObligation | null;
    try {
      cleanup = configCleanupFromOutput(op.output);
    } catch (error) {
      return {
        steps: [],
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (cleanup) return resumeConfigCleanup(deps, ctx, cleanup);

    const input = op.input as MigrateCustomerInput;
    const uid = typeof input.uid === "string" ? input.uid : undefined;
    const toGatewayId = typeof input.toGatewayId === "string" ? input.toGatewayId : undefined;

    if (!uid) {
      return { steps: [], success: false, error: "missing uid in op.input" };
    }
    if (!toGatewayId) {
      return { steps: [], success: false, error: "missing toGatewayId in op.input" };
    }

    const user = await deps.readUser(uid);
    if (!user) {
      return { steps: [], success: false, error: `user not found: ${uid}` };
    }

    const migrationId = deps.genMigrationId(op.id);
    let targets: MigrationTargets;
    let restoreSnapshot: FleetBrokerUserSnapshot | null;
    let systemConfigMigrationMode: SystemConfigMigrationMode;
    let rollFence: MigrationRollFence | null = null;
    const urls = new Map<string, string>();
    try {
      const resolved = await resolveMigrationTargets(deps, uid, user, toGatewayId);
      if ("error" in resolved) {
        return { steps: [], success: false, error: resolved.error };
      }
      targets = resolved.targets;
      if (input.source === "release-roll") {
        if (typeof input.rollOperationId !== "string" || input.rollOperationId.length === 0) {
          return {
            steps: [],
            success: false,
            error: "release-roll migration missing rollOperationId",
          };
        }
        if (targets.toRelease === null) {
          return { steps: [], success: false, error: "release-roll target has no release" };
        }
        rollFence = {
          uid,
          gatewayId: toGatewayId,
          rollOperationId: input.rollOperationId,
          targetRevisionId: targets.toRevisionId,
          targetRelease: targets.toRelease,
          sourceRevisionId: targets.fromRevisionId,
          sourceEpoch: targets.fromEpoch,
        };
        try {
          await deps.assertRollFence(rollFence);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            steps: [],
            success: false,
            error: message,
            rolledBack: false,
          };
        }
      }
      systemConfigMigrationMode = await deps.resolveSystemConfigMigrationMode(
        user.currentGatewayId,
        toGatewayId,
      );
      const requestedMode = requestedSystemConfigMigrationMode(input.systemConfigMigrationMode);
      if (requestedMode && requestedMode !== systemConfigMigrationMode) {
        throw new Error(
          `system config migration mode changed: requested=${requestedMode} resolved=${systemConfigMigrationMode}`,
        );
      }
      await deps.assertSystemConfigProtocolReady({
        mode: systemConfigMigrationMode,
        sourceGatewayId: targets.fromGatewayId,
        sourceRevisionId: targets.fromRevisionId,
        targetGatewayId: targets.toGatewayId,
        targetRevisionId: targets.toRevisionId,
      });
      urls.set(targets.fromTransportId, await deps.resolveGatewayUrl(targets.fromTransportId));
      urls.set(targets.toTransportId, await deps.resolveGatewayUrl(targets.toTransportId));
      restoreSnapshot = await deps.readUserSnapshot(uid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { steps: [], success: false, error: message };
    }
    if (!restoreSnapshot) {
      return { steps: [], success: false, error: `durable snapshot not found for ${uid}` };
    }
    const client = deps.buildClient((transportId) => {
      const url = urls.get(transportId);
      if (!url) {
        throw new Error(
          `migration client called with unexpected gatewayId: ${transportId}`,
        );
      }
      return url;
    });

    const result = await runMigration(
      {
        migrationId,
        uid,
        slug: user.slug,
        fromGatewayId: user.currentGatewayId,
        toGatewayId,
        fromTransportId: targets.fromTransportId,
        toTransportId: targets.toTransportId,
        crossGateway: user.currentGatewayId !== toGatewayId,
        toRevision: { revisionId: targets.toRevisionId, release: targets.toRelease ?? 0 },
        fromRevision: { revisionId: targets.fromRevisionId, release: targets.fromRelease },
        restoreSnapshot,
        includeActivationManifest: true,
        systemConfigMigrationMode,
        ...(rollFence ? { rollFence } : {}),
      },
      buildRunnerDeps(deps, client, ctx, targets.toRevisionId, deps.now, targets, rollFence),
    );

    return {
      steps: [],
      success: result.success,
      error: result.errorAt?.error,
      rolledBack: result.rolledBack,
      ...((result.configCheckpoint || result.configProof || result.configCleanup)
        ? {
            output: {
              ...(result.configCheckpoint ? { configCheckpoint: result.configCheckpoint } : {}),
              ...(result.configProof ? { configProof: result.configProof } : {}),
              ...(result.configCleanup ? { configCleanup: result.configCleanup } : {}),
            },
          }
        : {}),
    };
  };
}
