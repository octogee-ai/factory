import type {
  CustomerMigrationV2GatewayRootFence,
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
  customerMigrationV2GatewayRootFenceEqual,
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

  readGatewayRootFence: (
    gatewayId: string,
  ) => Promise<CustomerMigrationV2GatewayRootFence | null>;

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
  const initialized = await initializeOrdinaryMigrationV2(input);
  if ("success" in initialized) return initialized;
  const execution = {
    input,
    state: initialized,
    scopeChanged: ordinaryV2ScopeChanged(input, initialized),
  };
  while (execution.state.phase !== "complete" && execution.state.phase !== "aborted") {
    const outcome = await runOrdinaryV2Iteration(execution);
    if (outcome === "stop") break;
    if (outcome !== "continue") return outcome;
  }
  if (execution.state.phase === "aborted") {
    return {
      steps: [],
      success: false,
      error: execution.state.abortReason ?? "customer migration V2 aborted",
      rolledBack: true,
    };
  }
  return { steps: [], success: true, rolledBack: false };
}

interface OrdinaryV2Input {
  op: Operation;
  ctx: OperationContext;
  deps: MigrateCustomerDeps;
  targets: MigrationTargets;
  uid: string;
  slug: string;
  migrationId: string;
}

interface OrdinaryV2Execution {
  input: OrdinaryV2Input;
  state: CustomerMigrationV2State;
  scopeChanged: boolean;
}

function assertRootOwner(
  root: CustomerMigrationV2GatewayRootFence | null,
  uid: string,
  slug: string,
  role: "source" | "target",
): asserts root is CustomerMigrationV2GatewayRootFence {
  if (!root || root.ownerUid !== uid || root.builderSlug !== slug) {
    throw new Error(
      `customer migration V2 ${role} root ownership changed before initialization`,
    );
  }
}

async function initializeOrdinaryMigrationV2(
  input: OrdinaryV2Input,
): Promise<CustomerMigrationV2State | OperationResult> {
  const { op, ctx, deps, targets, uid, slug, migrationId } = input;
  if (targets.toRelease === null) {
    return { steps: [], success: false, error: "customer migration V2 target has no release" };
  }
  if (op.customerMigrationV2) return op.customerMigrationV2;
  const [sourceExecution, targetExecution, sourceRootFence, targetRootFence] = await Promise.all([
    deps.readRevisionExecutionIdentity(targets.fromRevisionId),
    deps.readRevisionExecutionIdentity(targets.toRevisionId),
    deps.readGatewayRootFence(targets.fromGatewayId),
    deps.readGatewayRootFence(targets.toGatewayId),
  ]);
  assertRootOwner(sourceRootFence, uid, slug, "source");
  assertRootOwner(targetRootFence, uid, slug, "target");
  const state: CustomerMigrationV2State = {
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
    sourceRootFence,
    targetGatewayId: targets.toGatewayId,
    targetRevisionId: targets.toRevisionId,
    targetRelease: targets.toRelease,
    targetRootFence,
    sourceImageTag: sourceExecution.imageTag,
    sourceBuildSha: sourceExecution.buildSha,
    sourceOpenclawVersion: sourceExecution.openclawVersion,
    targetImageTag: targetExecution.imageTag,
  };
  await persistV2(ctx, state);
  return state;
}

function ordinaryV2ScopeChanged(
  input: OrdinaryV2Input,
  state: CustomerMigrationV2State,
): boolean {
  const { op, targets, uid, slug, migrationId } = input;
  const declaredSourceGatewayId = typeof op.input.fromGatewayId === "string"
    ? op.input.fromGatewayId
    : null;
  return [
    state.operationId !== op.id,
    state.migrationId !== migrationId,
    state.uid !== uid,
    state.slug !== slug,
    state.sourceGatewayId !== targets.fromGatewayId,
    state.sourceRevisionId !== targets.fromRevisionId,
    state.sourceRelease !== targets.fromRelease,
    state.sourceEpoch !== targets.fromEpoch,
    state.sourceAssignmentMode !== targets.sourceAssignmentMode,
    state.targetGatewayId !== targets.toGatewayId,
    state.targetRevisionId !== targets.toRevisionId,
    state.targetRelease !== targets.toRelease,
    declaredSourceGatewayId !== null && declaredSourceGatewayId !== state.sourceGatewayId,
  ].some(Boolean);
}

async function cancellationResult(
  execution: OrdinaryV2Execution,
): Promise<OperationResult | null> {
  const { ctx, deps } = execution.input;
  const state = execution.state;
  if (isAbortPhase(state.phase) || isCustomerMigrationV2PostIntent(state)) return null;
  if (!await ctx.cancellationRequested?.()) return null;
  if (state.phase === "initialized") {
    return { steps: [], success: false, error: "customer migration cancelled before freeze" };
  }
  execution.state = beginCustomerMigrationV2Abort(
    state,
    "customer migration superseded",
    deps.now(),
  );
  await persistV2(ctx, execution.state);
  return null;
}

async function ordinaryV2IterationFailure(
  execution: OrdinaryV2Execution,
  error: unknown,
): Promise<OperationResult | "continue"> {
  if (classifyCustomerMigrationV2Error(error) === "retry") {
    return { steps: [], success: false, error: v2RetryError(error), rolledBack: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (isAbortPhase(execution.state.phase)) {
    return {
      steps: [],
      success: false,
      error: `customer migration V2 retry pending: status 503: abort cleanup blocked: ${message}`,
      rolledBack: false,
    };
  }
  if (isCustomerMigrationV2PostIntent(execution.state)) {
    return {
      steps: [],
      success: false,
      error: `customer migration V2 retry pending: status 503: roll-forward blocked: ${message}`,
      rolledBack: false,
    };
  }
  if (execution.state.phase === "initialized") {
    return { steps: [], success: false, error: message, rolledBack: false };
  }
  execution.state = beginCustomerMigrationV2Abort(
    execution.state,
    message,
    execution.input.deps.now(),
  );
  await persistV2(execution.input.ctx, execution.state);
  return "continue";
}

async function runOrdinaryV2Iteration(
  execution: OrdinaryV2Execution,
): Promise<OperationResult | "continue" | "stop"> {
  try {
    const cancelled = await cancellationResult(execution);
    if (cancelled) return cancelled;
    if (execution.scopeChanged && !isAbortPhase(execution.state.phase)) {
      throw new Error("durable customer migration V2 scope changed");
    }
    if (execution.state.phase === "initialized") {
      await assertV2InitialBindings(execution.state, execution.input.deps);
    }
    const driverDeps = await buildV2DriverDeps(execution.state, execution.input.deps);
    const next = await advanceCustomerMigrationV2(execution.state, driverDeps);
    if (next === execution.state) return "stop";
    execution.state = next;
    await persistV2(execution.input.ctx, execution.state);
    return "continue";
  } catch (error) {
    return ordinaryV2IterationFailure(execution, error);
  }
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
  const [source, target, sourceRootFence, targetRootFence] = await Promise.all([
    deps.resolveFromRevision(state.uid, state.sourceGatewayId),
    deps.resolvePlacement(state.targetGatewayId),
    deps.readGatewayRootFence(state.sourceGatewayId),
    deps.readGatewayRootFence(state.targetGatewayId),
  ]);
  const sourceIsExact = source !== null && [
    source.revisionId === state.sourceRevisionId,
    source.release === state.sourceRelease,
    (source.epoch ?? 0) === state.sourceEpoch,
    (source.assignmentMode ?? "assigned") === state.sourceAssignmentMode,
  ].every(Boolean);
  if (!sourceIsExact) {
    throw new Error("customer migration V2 source placement changed before freeze");
  }
  const targetIsExact = target?.ok === true && [
    target.revisionId === state.targetRevisionId,
    target.release === state.targetRelease,
  ].every(Boolean);
  if (!targetIsExact) {
    throw new Error("customer migration V2 target placement changed before freeze");
  }
  if (
    !sourceRootFence ||
    !customerMigrationV2GatewayRootFenceEqual(sourceRootFence, state.sourceRootFence)
  ) {
    throw new Error("customer migration V2 source root changed before freeze");
  }
  if (
    !targetRootFence ||
    !customerMigrationV2GatewayRootFenceEqual(targetRootFence, state.targetRootFence)
  ) {
    throw new Error("customer migration V2 target root changed before freeze");
  }
}

const V2_SOURCE_TRANSPORT_PHASES = new Set<CustomerMigrationV2State["phase"]>([
  "initialized", "preSynced", "cutover", "abortIntent",
]);
const V2_BOTH_TRANSPORT_PHASES = new Set<CustomerMigrationV2State["phase"]>([
  "targetPrepared", "candidateProven", "sourceQuiesced",
]);
const V2_TARGET_TRANSPORT_PHASES = new Set<CustomerMigrationV2State["phase"]>([
  "keysSynced", "targetRestored", "finalSynced", "targetVerified",
  "promotionIntent", "promoted", "sourceRetired", "abortPublished",
]);

function v2PhaseTransportIds(state: CustomerMigrationV2State): string[] {
  if (V2_SOURCE_TRANSPORT_PHASES.has(state.phase)) return [state.sourceRevisionId];
  if (V2_BOTH_TRANSPORT_PHASES.has(state.phase)) {
    return [state.sourceRevisionId, state.targetRevisionId];
  }
  return V2_TARGET_TRANSPORT_PHASES.has(state.phase) ? [state.targetRevisionId] : [];
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
  sourceAssignmentMode: "assigned" | "unassigned-live";
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

function durableMigrationTargets(state: CustomerMigrationV2State): MigrationTargets {
  return {
    toGatewayId: state.targetGatewayId,
    fromGatewayId: state.sourceGatewayId,
    toRevisionId: state.targetRevisionId,
    toRelease: state.targetRelease,
    fromRevisionId: state.sourceRevisionId,
    fromRelease: state.sourceRelease,
    fromEpoch: state.sourceEpoch,
    sourceAssignmentMode: state.sourceAssignmentMode,
    fromTransportId: state.sourceRevisionId,
    toTransportId: state.targetRevisionId,
  };
}

function terminalDurableMigrationResult(
  deps: MigrateCustomerDeps,
  op: Operation,
  input: MigrateCustomerInput,
  request: { uid: string; toGatewayId: string },
): OperationResult | null {
  const state = op.customerMigrationV2;
  if (state?.phase !== "complete" && state?.phase !== "aborted") return null;
  const scopeChanged = [
    state.operationId !== op.id,
    state.migrationId !== deps.genMigrationId(op.id),
    state.uid !== request.uid,
    state.targetGatewayId !== request.toGatewayId,
    typeof input.fromGatewayId === "string" &&
      input.fromGatewayId !== state.sourceGatewayId,
  ].some(Boolean);
  if (scopeChanged) return failure("durable customer migration V2 input changed");
  return state.phase === "complete"
    ? { steps: [], success: true, rolledBack: false }
    : {
        steps: [],
        success: false,
        error: state.abortReason ?? "customer migration V2 aborted",
        rolledBack: true,
      };
}

function resumeDurableMigration(
  deps: MigrateCustomerDeps,
  op: Operation,
  ctx: OperationContext,
): Promise<OperationResult> | null {
  const state = op.customerMigrationV2;
  if (!state) return null;
  return runOrdinaryMigrationV2({
    op,
    ctx,
    deps,
    targets: durableMigrationTargets(state),
    uid: state.uid,
    slug: state.slug,
    migrationId: state.migrationId,
  });
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
  ctx: OperationContext,
  migrationInput: MigrateCustomerInput,
  request: { uid: string; toGatewayId: string },
): Promise<PreparedMigration | { result: OperationResult } | { error: string; rolledBack?: false }> {
  let user: UserGatewayInfo | null;
  try {
    user = await deps.readUser(request.uid);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
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
    if (typeof migrationInput.fromGatewayId === "string" &&
      migrationInput.fromGatewayId !== resolved.targets.fromGatewayId) {
      return {
        error:
          `declared source ${migrationInput.fromGatewayId} does not match resolved source ${resolved.targets.fromGatewayId}`,
        rolledBack: false,
      };
    }
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
    const ordinaryV2 = systemConfigMigrationMode === "checkpoint-and-restore" &&
      migrationInput.source !== "release-roll";
    if (ordinaryV2) {
      const result = await executeOrdinaryMigrationV2({
        deps,
        op,
        ctx,
        targets: resolved.targets,
        uid: request.uid,
        slug: user.slug,
        migrationId,
      });
      return { result };
    }
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

async function executeOrdinaryMigrationV2(input: {
  deps: MigrateCustomerDeps;
  op: Operation;
  ctx: OperationContext;
  targets: MigrationTargets;
  uid: string;
  slug: string;
  migrationId: string;
}): Promise<OperationResult> {
  if (input.targets.toRelease === null) {
    return failure("customer migration V2 target has no release");
  }
  try {
    return await runOrdinaryMigrationV2(input);
  } catch (error) {
    if (classifyCustomerMigrationV2Error(error) === "retry") {
      return failure(v2RetryError(error), false);
    }
    return failure(error instanceof Error ? error.message : String(error), false);
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
    const input = op.input as MigrateCustomerInput;
    const request = migrationRequest(input);
    if ("error" in request) return failure(request.error);
    const terminal = terminalDurableMigrationResult(deps, op, input, request);
    if (terminal) return terminal;
    const resumed = resumeDurableMigration(deps, op, ctx);
    if (resumed) return resumed;
    const prepared = await prepareMigration(deps, op, ctx, input, request);
    if ("error" in prepared) return failure(prepared.error, prepared.rolledBack);
    if ("result" in prepared) return prepared.result;
    return executeMigration(deps, ctx, prepared);
  };
}
