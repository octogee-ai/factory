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
  preAcquiredConfigCheckpoint?: unknown;
}

interface PreAcquiredConfigCheckpoint {
  migrationId: string;
  checkpointCommit: string;
  configHash: string;
}

function requestedPreAcquiredConfigCheckpoint(
  value: unknown,
): PreAcquiredConfigCheckpoint | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid preAcquiredConfigCheckpoint in op.input");
  }
  const checkpoint = value as Record<string, unknown>;
  if (
    typeof checkpoint.migrationId !== "string" ||
    checkpoint.migrationId.length === 0 ||
    typeof checkpoint.checkpointCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(checkpoint.checkpointCommit) ||
    typeof checkpoint.configHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(checkpoint.configHash)
  ) {
    throw new Error("invalid preAcquiredConfigCheckpoint in op.input");
  }
  return {
    migrationId: checkpoint.migrationId,
    checkpointCommit: checkpoint.checkpointCommit,
    configHash: checkpoint.configHash,
  };
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

async function resolveRequestedSystemConfigMigrationMode(input: {
  deps: MigrateCustomerDeps;
  migrationInput: MigrateCustomerInput;
  sourceGatewayId: string;
  targetGatewayId: string;
}): Promise<SystemConfigMigrationMode> {
  const requestedMode = requestedSystemConfigMigrationMode(
    input.migrationInput.systemConfigMigrationMode,
  );
  if (input.migrationInput.source === "release-roll" && requestedMode === null) {
    return "none";
  }
  const resolvedMode = await input.deps.resolveSystemConfigMigrationMode(
    input.sourceGatewayId,
    input.targetGatewayId,
  );
  if (requestedMode && requestedMode !== resolvedMode) {
    throw new Error(
      `system config migration mode changed: requested=${requestedMode} resolved=${resolvedMode}`,
    );
  }
  return resolvedMode;
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
  const validShape = [
    typeof cleanup.migrationId === "string",
    typeof cleanup.slug === "string",
    typeof cleanup.sourceGatewayId === "string",
    typeof cleanup.sourceTransportId === "string",
    typeof resume.success === "boolean",
    typeof resume.rolledBack === "boolean",
    resume.error === undefined || typeof resume.error === "string",
  ].every(Boolean);
  if (!validShape) {
    throw new Error("invalid durable config cleanup obligation");
  }
  const configCheckpoint = optionalCleanupRecord<
    ConfigCleanupObligation["resume"]["configCheckpoint"]
  >(resume.configCheckpoint);
  const configProof = optionalCleanupRecord<
    ConfigCleanupObligation["resume"]["configProof"]
  >(resume.configProof);
  return {
    migrationId: cleanup.migrationId as string,
    slug: cleanup.slug as string,
    sourceGatewayId: cleanup.sourceGatewayId as string,
    sourceTransportId: cleanup.sourceTransportId as string,
    completeSourceUnmount: cleanup.completeSourceUnmount === true,
    resume: {
      success: resume.success as boolean,
      rolledBack: resume.rolledBack as boolean,
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
  input: {
    deps: MigrateCustomerDeps;
    client: MigrationClient;
    ctx: OperationContext;
    targetRevisionId: string;
    observedAt: () => number;
    targets: MigrationTargets;
    rollFence: MigrationRollFence | null;
  },
): MigrationRunnerDeps {
  const { deps, client, ctx, targetRevisionId, observedAt, targets, rollFence } = input;
  const runnerDeps: MigrationRunnerDeps = {
    client,
    commitCutover: deps.commitCutover,
    log: deps.log,
    reportStep: async (rep: ReportedStep) => {
      const step = reportedToOperationStep(rep, deps.now());
      await ctx.reportStep(step);
      const metricStage = configMetricStage(rep.name);
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

function configMetricStage(name: string): "checkpoint" | "proof" | "unfreeze" | null {
  if (name === "freeze-config") return "checkpoint";
  if (name === "prove-config-restore") return "proof";
  if (name === "unfreeze-config") return "unfreeze";
  return null;
}

interface PreparedMigration {
  uid: string;
  toGatewayId: string;
  user: UserGatewayInfo;
  migrationId: string;
  targets: MigrationTargets;
  restoreSnapshot: FleetBrokerUserSnapshot;
  systemConfigMigrationMode: SystemConfigMigrationMode;
  preAcquiredConfigCheckpoint: PreAcquiredConfigCheckpoint | null;
  rollFence: MigrationRollFence | null;
  urls: Map<string, string>;
}

function failure(error: string, rolledBack?: false): OperationResult {
  return {
    steps: [],
    success: false,
    error,
    ...(rolledBack === false ? { rolledBack } : {}),
  };
}

async function cleanupResult(
  deps: MigrateCustomerDeps,
  ctx: OperationContext,
  op: Operation,
): Promise<OperationResult | null> {
  try {
    const cleanup = configCleanupFromOutput(op.output);
    return cleanup ? resumeConfigCleanup(deps, ctx, cleanup) : null;
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

function migrationRequest(input: MigrateCustomerInput):
  | { uid: string; toGatewayId: string }
  | { error: string } {
  if (typeof input.uid !== "string" || input.uid.length === 0) {
    return { error: "missing uid in op.input" };
  }
  if (typeof input.toGatewayId !== "string" || input.toGatewayId.length === 0) {
    return { error: "missing toGatewayId in op.input" };
  }
  return { uid: input.uid, toGatewayId: input.toGatewayId };
}

async function prepareRollFence(input: {
  deps: MigrateCustomerDeps;
  migrationInput: MigrateCustomerInput;
  uid: string;
  toGatewayId: string;
  targets: MigrationTargets;
  preAcquiredConfigCheckpoint: PreAcquiredConfigCheckpoint | null;
}): Promise<{ rollFence: MigrationRollFence | null } | { error: string; rolledBack?: false }> {
  if (input.migrationInput.source !== "release-roll") return { rollFence: null };
  const operationId = input.migrationInput.rollOperationId;
  if (typeof operationId !== "string" || operationId.length === 0) {
    return { error: "release-roll migration missing rollOperationId" };
  }
  if (input.targets.toRelease === null) {
    return { error: "release-roll target has no release" };
  }
  const rollFence: MigrationRollFence = {
    uid: input.uid,
    gatewayId: input.toGatewayId,
    rollOperationId: operationId,
    targetRevisionId: input.targets.toRevisionId,
    targetRelease: input.targets.toRelease,
    sourceRevisionId: input.targets.fromRevisionId,
    sourceEpoch: input.targets.fromEpoch,
    ...(input.preAcquiredConfigCheckpoint
      ? { sourceConfigCheckpoint: input.preAcquiredConfigCheckpoint }
      : {}),
  };
  try {
    await input.deps.assertRollFence(rollFence);
    return { rollFence };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      rolledBack: false,
    };
  }
}

async function prepareMigration(
  deps: MigrateCustomerDeps,
  op: Operation,
): Promise<PreparedMigration | { error: string; rolledBack?: false }> {
  const migrationInput = op.input as MigrateCustomerInput;
  const request = migrationRequest(migrationInput);
  if ("error" in request) return request;
  const user = await deps.readUser(request.uid);
  if (!user) return { error: `user not found: ${request.uid}` };
  const migrationId = deps.genMigrationId(op.id);

  try {
    const resolved = await resolveMigrationTargets(
      deps,
      request.uid,
      user,
      request.toGatewayId,
    );
    if ("error" in resolved) return resolved;
    const preAcquiredConfigCheckpoint = requestedPreAcquiredConfigCheckpoint(
      migrationInput.preAcquiredConfigCheckpoint,
    );
    const fence = await prepareRollFence({
      deps,
      migrationInput,
      ...request,
      targets: resolved.targets,
      preAcquiredConfigCheckpoint,
    });
    if ("error" in fence) return fence;
    const systemConfigMigrationMode = await resolveRequestedSystemConfigMigrationMode({
      deps,
      migrationInput,
      sourceGatewayId: user.currentGatewayId,
      targetGatewayId: request.toGatewayId,
    });
    await deps.assertSystemConfigProtocolReady({
      mode: systemConfigMigrationMode,
      sourceGatewayId: resolved.targets.fromGatewayId,
      sourceRevisionId: resolved.targets.fromRevisionId,
      targetGatewayId: resolved.targets.toGatewayId,
      targetRevisionId: resolved.targets.toRevisionId,
    });
    const urls = new Map<string, string>();
    urls.set(
      resolved.targets.fromTransportId,
      await deps.resolveGatewayUrl(resolved.targets.fromTransportId),
    );
    urls.set(
      resolved.targets.toTransportId,
      await deps.resolveGatewayUrl(resolved.targets.toTransportId),
    );
    const restoreSnapshot = await deps.readUserSnapshot(request.uid);
    if (!restoreSnapshot) {
      return { error: `durable snapshot not found for ${request.uid}` };
    }
    return {
      ...request,
      user,
      migrationId,
      targets: resolved.targets,
      restoreSnapshot,
      systemConfigMigrationMode,
      preAcquiredConfigCheckpoint,
      rollFence: fence.rollFence,
      urls,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function migrationOutput(
  result: Awaited<ReturnType<typeof runMigration>>,
): Pick<OperationResult, "output"> | object {
  if (!result.configCheckpoint && !result.configProof && !result.configCleanup) return {};
  return {
    output: {
      ...(result.configCheckpoint ? { configCheckpoint: result.configCheckpoint } : {}),
      ...(result.configProof ? { configProof: result.configProof } : {}),
      ...(result.configCleanup ? { configCleanup: result.configCleanup } : {}),
    },
  };
}

async function executeMigration(
  deps: MigrateCustomerDeps,
  ctx: OperationContext,
  prepared: PreparedMigration,
): Promise<OperationResult> {
  const { targets } = prepared;
  const client = deps.buildClient((transportId) => {
    const url = prepared.urls.get(transportId);
    if (!url) {
      throw new Error(`migration client called with unexpected gatewayId: ${transportId}`);
    }
    return url;
  });
  const result = await runMigration(
    {
      migrationId: prepared.migrationId,
      uid: prepared.uid,
      slug: prepared.user.slug,
      fromGatewayId: prepared.user.currentGatewayId,
      toGatewayId: prepared.toGatewayId,
      fromTransportId: targets.fromTransportId,
      toTransportId: targets.toTransportId,
      crossGateway: prepared.user.currentGatewayId !== prepared.toGatewayId,
      toRevision: { revisionId: targets.toRevisionId, release: targets.toRelease ?? 0 },
      fromRevision: { revisionId: targets.fromRevisionId, release: targets.fromRelease },
      restoreSnapshot: prepared.restoreSnapshot,
      includeActivationManifest: true,
      systemConfigMigrationMode: prepared.systemConfigMigrationMode,
      ...(prepared.preAcquiredConfigCheckpoint
        ? { preAcquiredConfigCheckpoint: prepared.preAcquiredConfigCheckpoint }
        : {}),
      ...(prepared.rollFence ? { rollFence: prepared.rollFence } : {}),
    },
    buildRunnerDeps({
      deps,
      client,
      ctx,
      targetRevisionId: targets.toRevisionId,
      observedAt: deps.now,
      targets,
      rollFence: prepared.rollFence,
    }),
  );
  return {
    steps: [],
    success: result.success,
    error: result.errorAt?.error,
    rolledBack: result.rolledBack,
    ...migrationOutput(result),
  };
}

export function createMigrateCustomerHandler(deps: MigrateCustomerDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const cleanup = await cleanupResult(deps, ctx, op);
    if (cleanup) return cleanup;
    const prepared = await prepareMigration(deps, op);
    if ("error" in prepared) return failure(prepared.error, prepared.rolledBack);
    return executeMigration(deps, ctx, prepared);
  };
}
