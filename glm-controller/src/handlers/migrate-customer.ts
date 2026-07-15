import type {
  CustomerMigrationV2State,
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
  advanceCustomerMigrationV2,
  beginCustomerMigrationV2Abort,
  classifyCustomerMigrationV2Error,
  isCustomerMigrationV2PostIntent,
  type CustomerMigrationV2CutoverFence,
  type CustomerMigrationV2TargetContext,
} from "@octogee/core/customer-migration-v2";
import type { ConfigCandidateProofResponse } from "@octogee/shared/types/fleet-controller";
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
  assignmentMode?: "assigned" | "unassigned-live";
  rootUpdatedAt?: number;
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
    slug?: string;
    revisionId?: string;
    release?: number;
    epoch?: number;
    updatedByOperationId?: string;
    createIfMissing?: boolean;
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

  readRevisionExecutionIdentity: (revisionId: string) => Promise<{
    revisionId: string;
    imageTag: string;
    buildSha: string;
    openclawVersion: string;
    startedAt: number;
  }>;

  installTargetSystemConfigContext: (
    targetRevisionId: string,
    context: CustomerMigrationV2TargetContext,
  ) => Promise<void>;

  clearTargetSystemConfigContext: (targetRevisionId: string) => Promise<void>;

  assertCandidateProofCurrent: (
    targetRevisionId: string,
    expectedImageTag: string,
    proof: ConfigCandidateProofResponse,
  ) => Promise<void>;

  commitV2Cutover: (input: CustomerMigrationV2CutoverFence & {
    uid: string;
    slug: string;
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

function isAbortPhase(phase: CustomerMigrationV2State["phase"]): boolean {
  return phase === "abortIntent" ||
    phase === "abortPublished" ||
    phase === "abortTargetUnmounted" ||
    phase === "abortContextCleared" ||
    phase === "aborted";
}

function v2RetryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `customer migration V2 retry pending: status 503: ${message}`;
}

async function persistV2(
  ctx: OperationContext,
  state: CustomerMigrationV2State,
): Promise<void> {
  if (!ctx.persistCustomerMigrationV2) {
    throw new Error("customer migration V2 requires durable operation state persistence");
  }
  await ctx.persistCustomerMigrationV2(state);
}

async function runOrdinaryMigrationV2(input: {
  op: Operation;
  ctx: OperationContext;
  deps: MigrateCustomerDeps;
  targets: MigrationTargets;
  uid: string;
  slug: string;
  migrationId: string;
}): Promise<OperationResult> {
  const { op, ctx, deps, targets, uid, slug, migrationId } = input;
  if (targets.toRelease === null) {
    return { steps: [], success: false, error: "customer migration V2 target has no release" };
  }
  let state = op.customerMigrationV2;
  if (!state) {
    const [sourceExecution, targetExecution] = await Promise.all([
      deps.readRevisionExecutionIdentity(targets.fromRevisionId),
      deps.readRevisionExecutionIdentity(targets.toRevisionId),
    ]);
    state = {
      phase: "initialized",
      operationId: op.id,
      migrationId,
      uid,
      slug,
      sourceGatewayId: targets.fromGatewayId,
      sourceRevisionId: targets.fromRevisionId,
      sourceRelease: targets.fromRelease,
      sourceEpoch: targets.fromEpoch,
      sourceAssignmentMode: targets.sourceAssignmentMode,
      ...(targets.sourceRootUpdatedAt !== undefined
        ? { sourceRootUpdatedAt: targets.sourceRootUpdatedAt }
        : {}),
      targetGatewayId: targets.toGatewayId,
      targetRevisionId: targets.toRevisionId,
      targetRelease: targets.toRelease,
      sourceImageTag: sourceExecution.imageTag,
      sourceBuildSha: sourceExecution.buildSha,
      sourceOpenclawVersion: sourceExecution.openclawVersion,
      targetImageTag: targetExecution.imageTag,
    };
    await persistV2(ctx, state);
  }
  const declaredSourceGatewayId = typeof op.input.fromGatewayId === "string"
    ? op.input.fromGatewayId
    : null;
  const scopeChanged = (
    state.operationId !== op.id ||
    state.migrationId !== migrationId ||
    state.uid !== uid ||
    state.slug !== slug ||
    state.sourceGatewayId !== targets.fromGatewayId ||
    state.sourceRevisionId !== targets.fromRevisionId ||
    state.sourceRelease !== targets.fromRelease ||
    state.sourceEpoch !== targets.fromEpoch ||
    state.sourceAssignmentMode !== targets.sourceAssignmentMode ||
    state.sourceRootUpdatedAt !== targets.sourceRootUpdatedAt ||
    state.targetGatewayId !== targets.toGatewayId ||
    state.targetRevisionId !== targets.toRevisionId ||
    state.targetRelease !== targets.toRelease ||
    declaredSourceGatewayId !== null && declaredSourceGatewayId !== state.sourceGatewayId
  );

  while (state.phase !== "complete" && state.phase !== "aborted") {
    try {
      if (
        !isAbortPhase(state.phase) &&
        !isCustomerMigrationV2PostIntent(state) &&
        await ctx.cancellationRequested?.()
      ) {
        if (state.phase === "initialized") {
          return { steps: [], success: false, error: "customer migration cancelled before freeze" };
        }
        state = beginCustomerMigrationV2Abort(state, "customer migration superseded", deps.now());
        await persistV2(ctx, state);
      }
      if (scopeChanged && !isAbortPhase(state.phase)) {
        throw new Error("durable customer migration V2 scope changed");
      }
      if (state.phase === "initialized") {
        await assertV2InitialBindings(state, deps);
      }
      const driverDeps = await buildV2DriverDeps(state, deps);
      const next = await advanceCustomerMigrationV2(state, driverDeps);
      if (next === state) break;
      state = next;
      await persistV2(ctx, state);
    } catch (error) {
      if (classifyCustomerMigrationV2Error(error) === "retry") {
        return { steps: [], success: false, error: v2RetryError(error), rolledBack: false };
      }
      const message = error instanceof Error ? error.message : String(error);
      if (isAbortPhase(state.phase)) {
        return {
          steps: [],
          success: false,
          error: `customer migration V2 retry pending: status 503: abort cleanup blocked: ${message}`,
          rolledBack: false,
        };
      }
      if (isCustomerMigrationV2PostIntent(state)) {
        return {
          steps: [],
          success: false,
          error: `customer migration V2 retry pending: status 503: roll-forward blocked: ${message}`,
          rolledBack: false,
        };
      }
      if (state.phase === "initialized") {
        return { steps: [], success: false, error: message, rolledBack: false };
      }
      state = beginCustomerMigrationV2Abort(state, message, deps.now());
      await persistV2(ctx, state);
    }
  }

  if (state.phase === "aborted") {
    return {
      steps: [],
      success: false,
      error: state.abortReason ?? "customer migration V2 aborted",
      rolledBack: true,
    };
  }
  return { steps: [], success: true, rolledBack: false };
}

async function assertV2InitialBindings(
  state: CustomerMigrationV2State,
  deps: MigrateCustomerDeps,
): Promise<void> {
  await deps.assertSystemConfigProtocolReady({
    mode: "checkpoint-and-restore",
    sourceGatewayId: state.sourceGatewayId,
    sourceRevisionId: state.sourceRevisionId,
    targetGatewayId: state.targetGatewayId,
    targetRevisionId: state.targetRevisionId,
  });
  const [source, target] = await Promise.all([
    deps.resolveFromRevision(state.uid, state.sourceGatewayId),
    deps.resolvePlacement(state.targetGatewayId),
  ]);
  const sourceIsExact = source !== null &&
    source.revisionId === state.sourceRevisionId &&
    source.release === state.sourceRelease &&
    (source.epoch ?? 0) === state.sourceEpoch &&
    (source.assignmentMode ?? "assigned") === state.sourceAssignmentMode &&
    source.rootUpdatedAt === state.sourceRootUpdatedAt;
  if (!sourceIsExact) {
    throw new Error("customer migration V2 source placement changed before freeze");
  }
  const targetIsExact = target?.ok === true &&
    target.revisionId === state.targetRevisionId &&
    target.release === state.targetRelease;
  if (!targetIsExact) {
    throw new Error("customer migration V2 target placement changed before freeze");
  }
}

function v2PhaseTransportIds(state: CustomerMigrationV2State): string[] {
  switch (state.phase) {
    case "initialized":
    case "preSynced":
    case "cutover":
    case "abortIntent":
      return [state.sourceRevisionId];
    case "targetPrepared":
    case "candidateProven":
    case "sourceQuiesced":
      return [state.sourceRevisionId, state.targetRevisionId];
    case "keysSynced":
    case "targetRestored":
    case "finalSynced":
    case "targetVerified":
    case "promotionIntent":
    case "promoted":
    case "sourceRetired":
    case "abortPublished":
      return [state.targetRevisionId];
    case "checkpointed":
    case "finalized":
    case "abortTargetUnmounted":
    case "abortContextCleared":
    case "complete":
    case "aborted":
      return [];
  }
}

async function buildV2DriverDeps(
  state: CustomerMigrationV2State,
  deps: MigrateCustomerDeps,
) {
  const transportIds = v2PhaseTransportIds(state);
  const urls = new Map<string, string>();
  await Promise.all(transportIds.map(async (transportId) => {
    urls.set(transportId, await deps.resolveGatewayUrl(transportId));
  }));
  const client = deps.buildClient((transportId) => {
    const url = urls.get(transportId);
    if (!url) {
      throw new Error(`migration client called with unexpected gatewayId: ${transportId}`);
    }
    return url;
  });
  const restoreSnapshot = state.phase === "keysSynced"
    ? await deps.readUserSnapshot(state.uid)
    : undefined;
  if (state.phase === "keysSynced" && !restoreSnapshot) {
    throw new Error(`durable snapshot not found for ${state.uid}`);
  }
  return {
    client,
    ...(restoreSnapshot ? { restoreSnapshot } : {}),
    installTargetContext: (context: CustomerMigrationV2TargetContext) =>
      deps.installTargetSystemConfigContext(state.targetRevisionId, context),
    clearTargetContext: () => deps.clearTargetSystemConfigContext(state.targetRevisionId),
    assertCandidateProofCurrent: (proof: ConfigCandidateProofResponse) =>
      deps.assertCandidateProofCurrent(state.targetRevisionId, state.targetImageTag, proof),
    setSourceAssignmentState: (assignmentState: "serving" | "quiescing") =>
      deps.setAssignmentState({
        gatewayId: state.sourceGatewayId,
        uid: state.uid,
        state: assignmentState,
        slug: state.slug,
        revisionId: state.sourceRevisionId,
        release: state.sourceRelease,
        epoch: state.sourceEpoch,
        updatedByOperationId: state.operationId,
        createIfMissing: state.sourceAssignmentMode === "unassigned-live",
      }),
    commitCutover: (fence: CustomerMigrationV2CutoverFence) =>
      deps.commitV2Cutover({ ...fence, uid: state.uid, slug: state.slug }),
    now: deps.now,
  };
}

interface MigrateCustomerInput {
  uid?: unknown;
  fromGatewayId?: unknown;
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
  sourceAssignmentMode: "assigned" | "unassigned-live";
  sourceRootUpdatedAt?: number;
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
      sourceAssignmentMode: fromRevision.assignmentMode ?? "assigned",
      ...(fromRevision.rootUpdatedAt !== undefined
        ? { sourceRootUpdatedAt: fromRevision.rootUpdatedAt }
        : {}),
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

    const durableV2 = op.customerMigrationV2;
    if (durableV2?.phase === "complete" || durableV2?.phase === "aborted") {
      if (
        durableV2.operationId !== op.id ||
        durableV2.migrationId !== deps.genMigrationId(op.id) ||
        durableV2.uid !== uid ||
        durableV2.targetGatewayId !== toGatewayId ||
        typeof input.fromGatewayId === "string" &&
          input.fromGatewayId !== durableV2.sourceGatewayId
      ) {
        return { steps: [], success: false, error: "durable customer migration V2 input changed" };
      }
      return durableV2.phase === "complete"
        ? { steps: [], success: true, rolledBack: false }
        : {
            steps: [],
            success: false,
            error: durableV2.abortReason ?? "customer migration V2 aborted",
            rolledBack: true,
          };
    }

    if (durableV2) {
      const targets: MigrationTargets = {
        toGatewayId: durableV2.targetGatewayId,
        fromGatewayId: durableV2.sourceGatewayId,
        toRevisionId: durableV2.targetRevisionId,
        toRelease: durableV2.targetRelease,
        fromRevisionId: durableV2.sourceRevisionId,
        fromRelease: durableV2.sourceRelease,
        fromEpoch: durableV2.sourceEpoch,
        sourceAssignmentMode: durableV2.sourceAssignmentMode,
        ...(durableV2.sourceRootUpdatedAt !== undefined
          ? { sourceRootUpdatedAt: durableV2.sourceRootUpdatedAt }
          : {}),
        fromTransportId: durableV2.sourceRevisionId,
        toTransportId: durableV2.targetRevisionId,
      };
      return runOrdinaryMigrationV2({
        op,
        ctx,
        deps,
        targets,
        uid: durableV2.uid,
        slug: durableV2.slug,
        migrationId: durableV2.migrationId,
      });
    }

    let user: UserGatewayInfo | null;
    try {
      user = await deps.readUser(uid);
    } catch (error) {
      if (durableV2 && classifyCustomerMigrationV2Error(error) === "retry") {
        return { steps: [], success: false, error: v2RetryError(error), rolledBack: false };
      }
      return {
        steps: [],
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!user) {
      return { steps: [], success: false, error: `user not found: ${uid}` };
    }

    const migrationId = deps.genMigrationId(op.id);
    let targets: MigrationTargets;
    let restoreSnapshot: FleetBrokerUserSnapshot | null = null;
    let systemConfigMigrationMode: SystemConfigMigrationMode;
    let ordinaryV2 = false;
    let preAcquiredConfigCheckpoint: PreAcquiredConfigCheckpoint | null;
    let rollFence: MigrationRollFence | null = null;
    const urls = new Map<string, string>();
    try {
      const resolved = await resolveMigrationTargets(deps, uid, user, toGatewayId);
      if ("error" in resolved) {
        return { steps: [], success: false, error: resolved.error };
      }
      targets = resolved.targets;
      if (
        typeof input.fromGatewayId === "string" &&
        input.fromGatewayId !== targets.fromGatewayId
      ) {
        return {
          steps: [],
          success: false,
          error:
            `declared source ${input.fromGatewayId} does not match resolved source ${targets.fromGatewayId}`,
          rolledBack: false,
        };
      }
      preAcquiredConfigCheckpoint = requestedPreAcquiredConfigCheckpoint(
        input.preAcquiredConfigCheckpoint,
      );
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
          ...(preAcquiredConfigCheckpoint
            ? { sourceConfigCheckpoint: preAcquiredConfigCheckpoint }
            : {}),
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
      systemConfigMigrationMode = await resolveRequestedSystemConfigMigrationMode({
        deps,
        migrationInput: input,
        sourceGatewayId: user.currentGatewayId,
        targetGatewayId: toGatewayId,
      });
      ordinaryV2 = systemConfigMigrationMode === "checkpoint-and-restore" &&
        input.source !== "release-roll";
      if (!ordinaryV2) {
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
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (op.customerMigrationV2 && classifyCustomerMigrationV2Error(err) === "retry") {
        return { steps: [], success: false, error: v2RetryError(err), rolledBack: false };
      }
      return { steps: [], success: false, error: message };
    }
    if (ordinaryV2) {
      if (targets.toRelease === null) {
        return { steps: [], success: false, error: "customer migration V2 target has no release" };
      }
      try {
        return await runOrdinaryMigrationV2({
          op,
          ctx,
          deps,
          targets,
          uid,
          slug: user.slug,
          migrationId,
        });
      } catch (error) {
        if (classifyCustomerMigrationV2Error(error) === "retry") {
          return { steps: [], success: false, error: v2RetryError(error), rolledBack: false };
        }
        return {
          steps: [],
          success: false,
          error: error instanceof Error ? error.message : String(error),
          rolledBack: false,
        };
      }
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
        ...(preAcquiredConfigCheckpoint ? { preAcquiredConfigCheckpoint } : {}),
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
