import { createMigrationProgress } from "../migration-progress.js";
import type { MigrationProgressRequestBody } from "@octogee/shared/types/fleet-controller";
import type { NativeComputerReturn, NativeComputerReturnInput } from "../lib/native-computer-return.js";
import type {
  CustomerMigrationV2GatewayRootFence,
  CustomerMigrationV2State,
  Operation,
  OperationStep,
  StepStatus,
} from "@octogee/shared/types/glm";
import { resolveOperationOrigin } from "@octogee/shared/types/glm";
import type {
  FleetBrokerProjectCheckoutScope,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import type { GatewayArtifact } from "@octogee/core/gateway-live-release";
import {
  advanceCustomerMigrationV2,
  beginCustomerMigrationV2Abort,
  classifyCustomerMigrationV2Error,
  isCustomerMigrationV2PostIntent,
  customerMigrationV2GatewayRootFenceEqual,
  type CustomerMigrationV2CutoverFence,
} from "@octogee/core/customer-migration-v2";
import {
  runMigration,
  type CutoverCommit,
  type MigrationRunnerDeps,
  type ReportedStep,
} from "@octogee/core/fleet-migration-runner";
import {
  decideRollStateMigration,
  openclawVersionFromGatewayImageTag,
  type RollStateMigrationDecision,
} from "../roll-state-migration.js";

const MIGRATE_STATE = "migrate-state";
const PROVISION_FRESH = "provision-fresh";

// At most one migration per target gateway at a time. Enforced durably, before
// this handler ever runs, by the operation queue in index.ts (operation-queue.ts
// scopes migrate-customer exclusivity by toGatewayId); a conflicting request is
// queued there, not rejected here.

export interface UserGatewayInfo {
  slug: string;
  currentGatewayId: string;
}

export interface SourcePlacement {
  release: number;
  epoch?: number;
  assignmentMode?: "assigned" | "unassigned-live";
}

type PlacementResolution =
  | { ok: true; release: number | null }
  | { ok: false; reason: string };

export interface MigrateCustomerDeps {
  reportMigrationProgress: (gatewayId: string, event: MigrationProgressRequestBody) => Promise<void>;
  prepareNativeComputerReturn: (input: NativeComputerReturnInput) => Promise<NativeComputerReturn | null>;

  readUser: (uid: string) => Promise<UserGatewayInfo | null>;

  readUserSnapshot: (
    uid: string,
    toGatewayId: string,
  ) => Promise<FleetBrokerUserSnapshot | null>;

  /** The openclaw version a live gateway reports through its heartbeat. */
  readGatewayOpenclawVersion: (gatewayId: string) => Promise<string | null>;

  readGatewayReleaseArtifact: (
    gatewayId: string,
    release: number,
  ) => Promise<GatewayArtifact | null>;

  commitCutover: (commit: CutoverCommit & { automatic?: boolean }) => Promise<void>;

  resolveGatewayUrl: (gatewayId: string) => Promise<string>;

  buildClient: (resolveSync: (gatewayId: string) => string) => MigrationClient;

  resolveSourcePlacement: (uid: string, currentGatewayId: string) => Promise<SourcePlacement | null>;
  resolveTargetPlacement: (toGatewayId: string) => Promise<PlacementResolution | null>;

  setAssignmentState: (input: {
    gatewayId: string;
    uid: string;
    state: "serving" | "quiescing" | "migrating";
    slug?: string;
    epoch?: number;
    updatedByOperationId?: string;
    createIfMissing?: boolean;
    automatic?: boolean;
  }) => Promise<void>;

  readGatewayRootFence: (
    gatewayId: string,
  ) => Promise<CustomerMigrationV2GatewayRootFence | null>;

  commitV2Cutover: (input: CustomerMigrationV2CutoverFence & {
    uid: string;
    slug: string;
    automatic?: boolean;
  }) => Promise<void>;

  // Durable (V2) migration for Builder gateways; the legacy runner
  // covers shared-class customers with no durable target footprint to fence.
  useDurableMigration: (
    fromGatewayId: string,
    toGatewayId: string,
  ) => Promise<boolean>;

  genMigrationId: (operationId: string) => string;

  now: () => number;
  log: (msg: string) => void;
}

function isAbortPhase(phase: CustomerMigrationV2State["phase"]): boolean {
  return phase === "abortIntent" ||
    phase === "abortTargetUnmounted" ||
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
  const initialized = await initializeMigrationV2(input, MIGRATE_STATE);
  if ("success" in initialized) return initialized;
  const execution = {
    input,
    state: initialized,
    scopeChanged: ordinaryV2ScopeChanged(input, initialized),
    progress: createMigrationProgress({
      now: input.deps.now,
      log: (message) => input.deps.log(`${message} migrationId=${input.migrationId} builder=${input.slug}`),
      send: (event) => input.deps.reportMigrationProgress(input.targets.toGatewayId, {
        ...event, migrationId: input.migrationId, slug: input.slug, source: input.targets.fromGatewayId,
      }),
    }),
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
  progress: ReturnType<typeof createMigrationProgress>;
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

async function initializeMigrationV2(
  input: OrdinaryV2Input,
  strategy: "migrate-state" | "provision-fresh",
): Promise<CustomerMigrationV2State | OperationResult> {
  const { op, ctx, deps, targets, uid, slug, migrationId } = input;
  if (targets.toRelease === null) {
    return { steps: [], success: false, error: "customer migration V2 target has no release" };
  }
  if (op.customerMigrationV2) return op.customerMigrationV2;
  const [sourceRootFence, targetRootFence] = await Promise.all([
    deps.readGatewayRootFence(targets.fromGatewayId),
    deps.readGatewayRootFence(targets.toGatewayId),
  ]);
  assertRootOwner(sourceRootFence, uid, slug, "source");
  assertRootOwner(targetRootFence, uid, slug, "target");
  const state: CustomerMigrationV2State = {
    phase: "initialized",
    strategy,
    operationId: op.id,
    migrationId,
    uid,
    slug,
    sourceGatewayId: targets.fromGatewayId,
    sourceRelease: targets.fromRelease,
    sourceEpoch: targets.fromEpoch,
    sourceAssignmentMode: targets.sourceAssignmentMode,
    sourceRootFence,
    targetGatewayId: targets.toGatewayId,
    targetRelease: targets.toRelease,
    targetRootFence,
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
    (state.strategy ?? MIGRATE_STATE) !== MIGRATE_STATE,
    state.operationId !== op.id,
    state.migrationId !== migrationId,
    state.uid !== uid,
    state.slug !== slug,
    state.sourceGatewayId !== targets.fromGatewayId,
    state.sourceRelease !== targets.fromRelease,
    state.sourceEpoch !== targets.fromEpoch,
    state.sourceAssignmentMode !== targets.sourceAssignmentMode,
    state.targetGatewayId !== targets.toGatewayId,
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
    return { steps: [], success: false, error: "customer migration cancelled before transfer" };
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
  const retryable = classifyCustomerMigrationV2Error(error) === "retry";
  if (retryable && !requiresSourceResumeBeforeRetry(execution.state.phase)) {
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

function requiresSourceResumeBeforeRetry(
  phase: CustomerMigrationV2State["phase"],
): boolean {
  return phase === "preSynced" ||
    phase === "sourceQuiesced" ||
    phase === "finalSynced";
}

async function runOrdinaryV2Iteration(
  execution: OrdinaryV2Execution,
): Promise<OperationResult | "continue" | "stop"> {
  let phase = execution.state.phase;
  await execution.progress.report(phase, "running");
  try {
    const cancelled = await cancellationResult(execution);
    if (cancelled || execution.state.phase !== phase) {
      await execution.progress.report(phase, "skipped");
      if (cancelled) return cancelled;
      phase = execution.state.phase;
      await execution.progress.report(phase, "running");
    }
    if (execution.scopeChanged && !isAbortPhase(execution.state.phase)) {
      throw new Error("durable customer migration V2 scope changed");
    }
    if (execution.state.phase === "initialized") {
      await assertV2InitialBindings(execution.state, execution.input.deps);
    }
    const driverDeps = await buildV2DriverDeps(
      execution.state,
      execution.input.deps,
      resolveOperationOrigin(execution.input.op.origin) === "automatic",
    );
    const next = await advanceCustomerMigrationV2(execution.state, driverDeps);
    if (next === execution.state) {
      await execution.progress.report(phase, "pending");
      return "stop";
    }
    execution.state = next;
    await persistV2(execution.input.ctx, execution.state);
    await execution.progress.report(phase, "done");
    return "continue";
  } catch (error) {
    await execution.progress.report(phase, "failed");
    return ordinaryV2IterationFailure(execution, error);
  }
}

async function assertV2InitialBindings(
  state: CustomerMigrationV2State,
  deps: MigrateCustomerDeps,
): Promise<void> {
  const [source, target, sourceRootFence, targetRootFence] = await Promise.all([
    deps.resolveSourcePlacement(state.uid, state.sourceGatewayId),
    deps.resolveTargetPlacement(state.targetGatewayId),
    deps.readGatewayRootFence(state.sourceGatewayId),
    deps.readGatewayRootFence(state.targetGatewayId),
  ]);
  const sourceIsExact = source !== null && [
    source.release === state.sourceRelease,
    (source.epoch ?? 0) === state.sourceEpoch,
    (source.assignmentMode ?? "assigned") === state.sourceAssignmentMode,
  ].every(Boolean);
  if (!sourceIsExact) {
    throw new Error("customer migration V2 source placement changed before transfer");
  }
  const targetIsExact = target?.ok === true && target.release === state.targetRelease;
  if (!targetIsExact) {
    throw new Error("customer migration V2 target placement changed before transfer");
  }
  if (
    !sourceRootFence ||
    !customerMigrationV2GatewayRootFenceEqual(sourceRootFence, state.sourceRootFence)
  ) {
    throw new Error("customer migration V2 source root changed before transfer");
  }
  if (
    !targetRootFence ||
    !customerMigrationV2GatewayRootFenceEqual(targetRootFence, state.targetRootFence)
  ) {
    throw new Error("customer migration V2 target root changed before transfer");
  }
}

const V2_SOURCE_TRANSPORT_PHASES = new Set<CustomerMigrationV2State["phase"]>([
  "initialized", "keysSynced", "preSynced", "cutover", "abortIntent",
]);
const V2_BOTH_TRANSPORT_PHASES = new Set<CustomerMigrationV2State["phase"]>([
  "sourceQuiesced",
]);
const V2_TARGET_TRANSPORT_PHASES = new Set<CustomerMigrationV2State["phase"]>([
  "finalSynced", "targetVerified", "sourceRetired",
]);

function v2PhaseTransportIds(state: CustomerMigrationV2State): string[] {
  if (V2_SOURCE_TRANSPORT_PHASES.has(state.phase)) return [state.sourceGatewayId];
  if (V2_BOTH_TRANSPORT_PHASES.has(state.phase)) {
    return [state.sourceGatewayId, state.targetGatewayId];
  }
  return V2_TARGET_TRANSPORT_PHASES.has(state.phase) ? [state.targetGatewayId] : [];
}

async function buildV2DriverDeps(
  state: CustomerMigrationV2State,
  deps: MigrateCustomerDeps,
  automatic: boolean,
) {
  const transportIds = new Set([
    ...v2PhaseTransportIds(state),
    // Every source-driven push resolves the target URL too.
    state.targetGatewayId,
  ]);
  const urls = new Map<string, string>();
  await Promise.all([...transportIds].map(async (transportId) => {
    urls.set(transportId, await deps.resolveGatewayUrl(transportId));
  }));
  const client = deps.buildClient((transportId) => {
    const url = urls.get(transportId);
    if (!url) {
      throw new Error(`migration client called with unexpected gatewayId: ${transportId}`);
    }
    return url;
  });
  return {
    client,
    setSourceAssignmentState: (assignmentState: "serving" | "quiescing") =>
      deps.setAssignmentState({
        gatewayId: state.sourceGatewayId,
        uid: state.uid,
        state: assignmentState,
        slug: state.slug,
        epoch: state.sourceEpoch,
        updatedByOperationId: state.operationId,
        createIfMissing: state.sourceAssignmentMode === "unassigned-live",
        automatic,
      }),
    commitCutover: (fence: CustomerMigrationV2CutoverFence) =>
      deps.commitV2Cutover({ ...fence, uid: state.uid, slug: state.slug, automatic }),
    now: deps.now,
  };
}

interface MigrateCustomerInput {
  uid?: unknown;
  fromGatewayId?: unknown;
  toGatewayId?: unknown;
  source?: unknown;
}

function isControllerConvergenceSource(source: unknown): boolean {
  return source === "builder-activation-lease" ||
    source === "continuous-placement-policy";
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
  toRelease: number | null;
  fromRelease: number;
  fromEpoch: number;
  sourceAssignmentMode: "assigned" | "unassigned-live";
}

async function resolveMigrationTargets(
  deps: MigrateCustomerDeps,
  uid: string,
  user: UserGatewayInfo,
  toGatewayId: string,
): Promise<{ targets: MigrationTargets } | { error: string }> {
  if (user.currentGatewayId === toGatewayId) {
    return { error: `customer already on ${toGatewayId}` };
  }
  const source = await deps.resolveSourcePlacement(uid, user.currentGatewayId);
  if (!source) {
    return {
      error: `source gateway ${user.currentGatewayId} has no durable placement`,
    };
  }
  const placement = await deps.resolveTargetPlacement(toGatewayId);
  if (placement === null) {
    return { error: `target gateway ${toGatewayId} has no durable placement` };
  }
  if (placement.ok === false) {
    return { error: `placement rejected for ${toGatewayId}: ${placement.reason}` };
  }

  return {
    targets: {
      toGatewayId,
      fromGatewayId: user.currentGatewayId,
      toRelease: placement.release,
      fromRelease: source.release,
      fromEpoch: source.epoch ?? 0,
      sourceAssignmentMode: source.assignmentMode ?? "assigned",
    },
  };
}

function buildRunnerDeps(
  input: {
    deps: MigrateCustomerDeps;
    client: MigrationClient;
    ctx: OperationContext;
    automatic: boolean;
    operationId: string;
  },
): MigrationRunnerDeps {
  const { deps, client, ctx } = input;
  return {
    client,
    commitCutover: (commit) => deps.commitCutover({ ...commit, automatic: input.automatic }),
    setAssignmentState: (assignment) =>
      deps.setAssignmentState({
        ...assignment,
        updatedByOperationId: input.operationId,
        automatic: input.automatic,
      }),
    log: deps.log,
    reportStep: async (rep: ReportedStep) => {
      await ctx.reportStep(reportedToOperationStep(rep, deps.now()));
    },
  };
}

interface PreparedMigration {
  uid: string;
  toGatewayId: string;
  user: UserGatewayInfo;
  migrationId: string;
  targets: MigrationTargets;
  projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
  urls: Map<string, string>;
  stateMigration: RollStateMigrationDecision;
}

// OpenClaw state does not survive a version change, so a cross-version move
// carries none: the source flushes its durable work, the cutover flips the
// roster, and the destination's own reconcile mounts the customer from
// Firestore/Gitea/Mattermost like any other assigned customer.
async function provisionCustomerOnTarget(input: {
  deps: MigrateCustomerDeps;
  ctx: OperationContext;
  operationId: string;
  targets: MigrationTargets;
  uid: string;
  slug: string;
  migrationId: string;
  stateMigration: RollStateMigrationDecision;
  automatic: boolean;
  nativeReturn?: NativeComputerReturn | null;
}): Promise<OperationResult> {
  const { deps, targets, uid, slug, migrationId, automatic } = input;
  const ctx = destinationProgressContext(input);
  deps.log(
    `[migrate-customer] ${targets.fromGatewayId} → ${targets.toGatewayId} slug=${slug}: ` +
    `provision-fresh (${input.stateMigration.reason})`,
  );
  const sourceUrl = await deps.resolveGatewayUrl(targets.fromGatewayId);
  const client = deps.buildClient((transportId) => {
    if (transportId !== targets.fromGatewayId) {
      throw new Error(`migration client called with unexpected gatewayId: ${transportId}`);
    }
    return sourceUrl;
  });
  const step = (name: string, action: () => Promise<unknown>) =>
    reportFreshStep(deps, ctx, name, action);
  const sourceAssignment = {
    gatewayId: targets.fromGatewayId,
    uid,
    slug,
    epoch: targets.fromEpoch,
    updatedByOperationId: input.operationId,
    automatic,
  };
  try {
    await deps.setAssignmentState({
      ...sourceAssignment,
      state: "quiescing",
      createIfMissing: targets.sourceAssignmentMode === "unassigned-live",
    });
    if (!input.nativeReturn?.checkpointRequested) {
      await step("quiesce-source", () => client.quiesce({
        migrationId,
        gatewayId: targets.fromGatewayId,
        slug,
      }));
      await step("flush-source", () => client.flushGateway({
        migrationId,
        gatewayId: targets.fromGatewayId,
        slug,
        reason: "migration-final",
      }));
    }
    if (input.nativeReturn) await step("checkpoint-native-computer", input.nativeReturn.checkpoint);
    await step("cutover-firestore", () => deps.commitCutover({
      uid,
      slug,
      toGatewayId: targets.toGatewayId,
      fromGatewayId: targets.fromGatewayId,
      flipMirror: targets.fromGatewayId !== targets.toGatewayId,
      automatic,
    }));
  } catch (error) {
    if (input.nativeReturn) {
      const current = await deps.readUser(uid);
      if (current?.currentGatewayId === targets.toGatewayId) {
        await input.nativeReturn.release();
        await discardSourceFootprint(deps, ctx, { client, migrationId, gatewayId: targets.fromGatewayId, slug });
        return { steps: [], success: true, rolledBack: false };
      }
      if (current?.currentGatewayId !== targets.fromGatewayId) {
        throw new Error("native return ownership changed; checkpoint retained");
      }
      await input.nativeReturn.release();
    }
    await restoreSourceServing(deps, {
      ...sourceAssignment,
      state: "serving",
      createIfMissing: false,
    });
    return { steps: [], success: false, error: errorMessage(error), rolledBack: true };
  }
  if (input.nativeReturn) await input.nativeReturn.release();
  await discardSourceFootprint(deps, ctx, {
    client,
    migrationId,
    gatewayId: targets.fromGatewayId,
    slug,
  });
  return { steps: [], success: true, rolledBack: false };
}

interface ProvisionFreshV2Input {
  deps: MigrateCustomerDeps;
  ctx: OperationContext;
  op: Operation;
  targets: MigrationTargets;
  uid: string;
  slug: string;
  migrationId: string;
  automatic: boolean;
}

interface ProvisionFreshV2Execution {
  input: ProvisionFreshV2Input;
  state: CustomerMigrationV2State;
  sourceAssignment: Parameters<MigrateCustomerDeps["setAssignmentState"]>[0];
}

async function initializeProvisionFreshV2(
  input: ProvisionFreshV2Input,
): Promise<ProvisionFreshV2Execution | OperationResult> {
  const { deps, ctx, op, targets, uid, slug, migrationId, automatic } = input;
  let initialized: CustomerMigrationV2State | OperationResult;
  try {
    initialized = await initializeMigrationV2({
      op,
      ctx,
      deps,
      targets,
      uid,
      slug,
      migrationId,
    }, PROVISION_FRESH);
  } catch (error) {
    return failure(errorMessage(error), false);
  }
  if ("success" in initialized) return initialized;
  const state = initialized;
  const declaredSourceGatewayId = typeof op.input.fromGatewayId === "string"
    ? op.input.fromGatewayId
    : null;
  const scopeChanged = [
    state.operationId !== op.id,
    state.migrationId !== deps.genMigrationId(op.id),
    op.input.uid !== state.uid,
    op.input.toGatewayId !== state.targetGatewayId,
    declaredSourceGatewayId !== null && declaredSourceGatewayId !== state.sourceGatewayId,
  ].some(Boolean);
  const execution: ProvisionFreshV2Execution = {
    input,
    state,
    sourceAssignment: {
      gatewayId: targets.fromGatewayId,
      uid,
      slug,
      epoch: targets.fromEpoch,
      updatedByOperationId: op.id,
      automatic,
      state: "quiescing",
    },
  };
  const revalidation = await revalidateResumedProvisionFresh(execution);
  if (revalidation) return revalidation;
  if (
    scopeChanged &&
    execution.state.phase !== "cutover" &&
    execution.state.phase !== "sourceRetired"
  ) {
    return abortProvisionFreshV2(
      execution,
      new Error("durable provision-fresh migration input changed"),
    );
  }
  if (execution.state.phase === "initialized") {
    deps.log(
      `[migrate-customer] ${targets.fromGatewayId} → ${targets.toGatewayId} slug=${slug}: ` +
      "provision-fresh (durable fenced cutover)",
    );
  }
  return execution;
}

async function persistProvisionFreshV2Phase(
  execution: ProvisionFreshV2Execution,
  state: CustomerMigrationV2State,
): Promise<OperationResult | null> {
  execution.state = state;
  try {
    await persistV2(execution.input.ctx, state);
    return null;
  } catch (error) {
    return failure(v2RetryError(error), false);
  }
}

async function abortProvisionFreshV2(
  execution: ProvisionFreshV2Execution,
  error: unknown,
): Promise<OperationResult> {
  const { deps } = execution.input;
  try {
    await deps.setAssignmentState({
      ...execution.sourceAssignment,
      state: "serving",
      createIfMissing: false,
    });
  } catch (restoreError) {
    deps.log(
      `[migrate-customer] ❌ FAILED to restore assignment serving for ` +
      `uid=${execution.sourceAssignment.uid} on ${execution.sourceAssignment.gatewayId}: ` +
      `${errorMessage(restoreError)} — the customer stays quiescing`,
    );
    return failure(v2RetryError(restoreError), false);
  }
  const aborted: CustomerMigrationV2State = {
    ...execution.state,
    phase: "aborted",
    abortFromPhase: execution.state.phase,
    abortReason: errorMessage(error),
    abortedAt: deps.now(),
  };
  const persistenceFailure = await persistProvisionFreshV2Phase(execution, aborted);
  if (persistenceFailure) return persistenceFailure;
  return {
    steps: [],
    success: false,
    error: errorMessage(error),
    rolledBack: true,
  };
}

function provisionFreshPhaseNeedsRevalidation(
  phase: CustomerMigrationV2State["phase"],
): boolean {
  return phase === "initialized" ||
    phase === "freshSourceQuiesced" ||
    phase === "freshCutoverReady";
}

async function freshCutoverOwnership(
  execution: ProvisionFreshV2Execution,
): Promise<"source" | "target" | OperationResult> {
  const { deps } = execution.input;
  const state = execution.state;
  let currentUser: UserGatewayInfo | null;
  try {
    currentUser = await deps.readUser(state.uid);
  } catch (error) {
    return failure(v2RetryError(error), false);
  }
  if (currentUser === null || currentUser.slug !== state.slug) {
    return failure(v2RetryError(
      new Error("cannot verify fresh cutover ownership"),
    ), false);
  }
  if (currentUser.currentGatewayId === state.targetGatewayId) return "target";
  if (currentUser.currentGatewayId === state.sourceGatewayId) return "source";
  return failure(v2RetryError(
    new Error(
      `fresh cutover ownership moved to unexpected gateway ` +
      currentUser.currentGatewayId,
    ),
  ), false);
}

async function revalidateResumedProvisionFresh(
  execution: ProvisionFreshV2Execution,
): Promise<OperationResult | null> {
  const { deps, op, targets } = execution.input;
  const state = execution.state;
  if (
    op.customerMigrationV2 === undefined ||
    !provisionFreshPhaseNeedsRevalidation(state.phase)
  ) {
    return null;
  }
  if (state.phase === "freshCutoverReady") {
    const ownership = await freshCutoverOwnership(execution);
    if (typeof ownership !== "string") return ownership;
    if (ownership === "target") {
      return advanceProvisionFreshCutoverReady(execution);
    }
  }
  try {
    const decision = await decideCustomerStateMigration(deps, targets);
    if (decision.strategy === PROVISION_FRESH) return null;
    return abortProvisionFreshV2(
      execution,
      new Error(
        "fenced openclaw identity no longer authorizes provision-fresh migration",
      ),
    );
  } catch (error) {
    return abortProvisionFreshV2(execution, error);
  }
}

async function provisionFreshSourceClient(
  execution: ProvisionFreshV2Execution,
): Promise<MigrationClient> {
  const { deps } = execution.input;
  const gatewayId = execution.state.sourceGatewayId;
  const sourceUrl = await deps.resolveGatewayUrl(gatewayId);
  return deps.buildClient((transportId) => {
    if (transportId !== gatewayId) {
      throw new Error(`migration client called with unexpected gatewayId: ${transportId}`);
    }
    return sourceUrl;
  });
}

async function advanceProvisionFreshInitialized(
  execution: ProvisionFreshV2Execution,
): Promise<OperationResult | null> {
  const { deps, ctx, targets, migrationId, slug } = execution.input;
  try {
    await assertV2InitialBindings(execution.state, deps);
    const client = await provisionFreshSourceClient(execution);
    await deps.setAssignmentState({
      ...execution.sourceAssignment,
      createIfMissing: targets.sourceAssignmentMode === "unassigned-live",
    });
    await reportFreshStep(deps, ctx, "quiesce-source", () => client.quiesce({
      migrationId,
      gatewayId: targets.fromGatewayId,
      slug,
    }));
    await reportFreshStep(deps, ctx, "flush-source", () => client.flushGateway({
      migrationId,
      gatewayId: targets.fromGatewayId,
      slug,
      reason: "migration-final",
    }));
    return persistProvisionFreshV2Phase(execution, {
      ...execution.state,
      phase: "freshSourceQuiesced",
    });
  } catch (error) {
    return abortProvisionFreshV2(execution, error);
  }
}

async function advanceProvisionFreshSourceQuiesced(
  execution: ProvisionFreshV2Execution,
): Promise<OperationResult | null> {
  return persistProvisionFreshV2Phase(execution, {
    ...execution.state,
    phase: "freshCutoverReady",
  });
}

async function advanceProvisionFreshCutoverReady(
  execution: ProvisionFreshV2Execution,
): Promise<OperationResult | null> {
  const { deps, ctx, automatic } = execution.input;
  const state = execution.state;
  try {
    await reportFreshStep(deps, ctx, "cutover-firestore", () => deps.commitV2Cutover({
      strategy: PROVISION_FRESH,
      operationId: state.operationId,
      migrationId: state.migrationId,
      sourceGatewayId: state.sourceGatewayId,
      sourceEpoch: state.sourceEpoch,
      sourceRelease: state.sourceRelease,
      sourceAssignmentMode: state.sourceAssignmentMode,
      sourceRootFence: state.sourceRootFence,
      targetGatewayId: state.targetGatewayId,
      targetRelease: state.targetRelease,
      targetRootFence: state.targetRootFence,
      uid: state.uid,
      slug: state.slug,
      automatic,
    }));
  } catch (error) {
    if (classifyCustomerMigrationV2Error(error) === "retry") {
      return failure(v2RetryError(error), false);
    }
    return abortProvisionFreshV2(execution, error);
  }
  return persistProvisionFreshV2Phase(execution, {
    ...state,
    phase: "cutover",
    cutoverAt: deps.now(),
  });
}

async function cleanupProvisionFreshSource(
  execution: ProvisionFreshV2Execution,
): Promise<void> {
  const { deps, ctx } = execution.input;
  const state = execution.state;
  try {
    const client = await provisionFreshSourceClient(execution);
    await discardSourceFootprint(deps, ctx, {
      client,
      migrationId: state.migrationId,
      gatewayId: state.sourceGatewayId,
      slug: state.slug,
    });
  } catch (error) {
    deps.log(
      `[migrate-customer] ⚠ source cleanup unavailable after fresh durable cutover ` +
      `gateway=${state.sourceGatewayId} slug=${state.slug}: ${errorMessage(error)}`,
    );
  }
}

async function advanceProvisionFreshCutover(
  execution: ProvisionFreshV2Execution,
): Promise<OperationResult | null> {
  await cleanupProvisionFreshSource(execution);
  return persistProvisionFreshV2Phase(execution, {
    ...execution.state,
    phase: "sourceRetired",
    sourceRetiredAt: execution.input.deps.now(),
  });
}

async function advanceProvisionFreshSourceRetired(
  execution: ProvisionFreshV2Execution,
): Promise<OperationResult | null> {
  return persistProvisionFreshV2Phase(execution, {
    ...execution.state,
    phase: "complete",
    completedAt: execution.input.deps.now(),
  });
}

const PROVISION_FRESH_ADVANCE = {
  initialized: advanceProvisionFreshInitialized,
  freshSourceQuiesced: advanceProvisionFreshSourceQuiesced,
  freshCutoverReady: advanceProvisionFreshCutoverReady,
  cutover: advanceProvisionFreshCutover,
  sourceRetired: advanceProvisionFreshSourceRetired,
} as const;

async function runProvisionFreshV2(
  execution: ProvisionFreshV2Execution,
): Promise<OperationResult> {
  while (true) {
    const { state } = execution;
    if ((state.strategy ?? MIGRATE_STATE) !== PROVISION_FRESH) {
      return failure("durable provision-fresh migration strategy changed", false);
    }
    if (state.phase === "complete") {
      return { steps: [], success: true, rolledBack: false };
    }
    if (state.phase === "aborted") {
      return {
        steps: [],
        success: false,
        error: state.abortReason ?? "durable provision-fresh migration aborted",
        rolledBack: true,
      };
    }
    if (
      state.phase !== "cutover" &&
      state.phase !== "sourceRetired" &&
      await execution.input.ctx.cancellationRequested?.()
    ) {
      return abortProvisionFreshV2(execution, new Error("customer migration cancelled"));
    }
    const advance = PROVISION_FRESH_ADVANCE[
      state.phase as keyof typeof PROVISION_FRESH_ADVANCE
    ];
    if (!advance) {
      return failure(`invalid durable provision-fresh migration phase: ${state.phase}`, false);
    }
    const result = await advance(execution);
    if (result) return result;
  }
}

async function provisionCustomerOnTargetV2(
  input: ProvisionFreshV2Input,
): Promise<OperationResult> {
  const initialized = await initializeProvisionFreshV2({ ...input, ctx: destinationProgressContext(input) });
  if ("success" in initialized) return initialized;
  return runProvisionFreshV2(initialized);
}

function destinationProgressContext(input: Pick<ProvisionFreshV2Input, "deps" | "ctx" | "targets" | "slug" | "migrationId">): OperationContext {
  const { deps, ctx, targets, slug, migrationId } = input;
  const progress = createMigrationProgress({
    now: deps.now,
    log: (message) => deps.log(`${message} migrationId=${migrationId} builder=${slug}`),
    send: (event) => deps.reportMigrationProgress(targets.toGatewayId, {
      ...event, migrationId, slug, source: targets.fromGatewayId,
    }),
  });
  return {
    ...ctx,
    reportStep: async (step) => {
      await ctx.reportStep(step);
      await progress.report(step.name, step.status);
    },
  };
}

async function reportFreshStep(
  deps: MigrateCustomerDeps,
  ctx: OperationContext,
  name: string,
  action: () => Promise<unknown>,
): Promise<void> {
  await ctx.reportStep(reportedToOperationStep({ name, status: "running" }, deps.now()));
  try {
    await action();
  } catch (error) {
    await ctx.reportStep(reportedToOperationStep(
      { name, status: "failed", error: errorMessage(error) },
      deps.now(),
    ));
    throw error;
  }
  await ctx.reportStep(reportedToOperationStep({ name, status: "done" }, deps.now()));
}

// Post-cutover cleanup: the destination already owns the customer, so a source
// that cannot be reached stays a stale local footprint for Cowboy's eviction
// sweep rather than failing a migration that has already landed.
async function discardSourceFootprint(
  deps: MigrateCustomerDeps,
  ctx: OperationContext,
  input: {
    client: MigrationClient;
    migrationId: string;
    gatewayId: string;
    slug: string;
  },
): Promise<void> {
  try {
    await reportFreshStep(deps, ctx, "unmount-source", () => input.client.unmount({
      migrationId: input.migrationId,
      gatewayId: input.gatewayId,
      slug: input.slug,
    }));
  } catch (error) {
    deps.log(
      `[migrate-customer] ⚠ source unmount failed after cutover gateway=${input.gatewayId} ` +
      `slug=${input.slug}: ${errorMessage(error)} — the destination already serves`,
    );
  }
}

// The customer stays quiescing (the edge answers 503) until a retry re-drives
// the migration, so a failure here is loud.
async function restoreSourceServing(
  deps: MigrateCustomerDeps,
  assignment: Parameters<MigrateCustomerDeps["setAssignmentState"]>[0],
): Promise<void> {
  try {
    await deps.setAssignmentState(assignment);
  } catch (error) {
    deps.log(
      `[migrate-customer] ❌ FAILED to restore assignment serving for uid=${assignment.uid} ` +
      `on ${assignment.gatewayId}: ${errorMessage(error)} — the customer stays quiescing`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: string, rolledBack?: false): OperationResult {
  return {
    steps: [],
    success: false,
    error,
    ...(rolledBack === false ? { rolledBack } : {}),
  };
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
    toRelease: state.targetRelease,
    fromRelease: state.sourceRelease,
    fromEpoch: state.sourceEpoch,
    sourceAssignmentMode: state.sourceAssignmentMode,
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
  if ((state.strategy ?? MIGRATE_STATE) === PROVISION_FRESH) {
    return provisionCustomerOnTargetV2({
      deps,
      op,
      ctx,
      targets: durableMigrationTargets(state),
      uid: state.uid,
      slug: state.slug,
      migrationId: state.migrationId,
      automatic: resolveOperationOrigin(op.origin) === "automatic",
    });
  }
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

async function executeProvisionFresh(input: ProvisionFreshV2Input & {
  stateMigration: RollStateMigrationDecision;
  durable: boolean;
  nativeReturn?: NativeComputerReturn | null;
}): Promise<OperationResult> {
  if (input.nativeReturn && input.durable) throw new Error("native computer returns require a Shared target");
  if (input.durable) return provisionCustomerOnTargetV2(input);
  return provisionCustomerOnTarget({
    deps: input.deps,
    ctx: input.ctx,
    operationId: input.op.id,
    targets: input.targets,
    uid: input.uid,
    slug: input.slug,
    migrationId: input.migrationId,
    stateMigration: input.stateMigration,
    automatic: input.automatic,
    nativeReturn: input.nativeReturn,
  });
}

function nativeReturnDecision(identity: RollStateMigrationDecision, native: NativeComputerReturn | null): RollStateMigrationDecision {
  return native ? { ...identity, strategy: PROVISION_FRESH, reason: "preserve native computer state; provision standard coach on Shared" } : identity;
}

async function finishNativeReturnAfterCutover(deps: MigrateCustomerDeps, op: Operation, ctx: OperationContext, user: UserGatewayInfo): Promise<void> {
  if (typeof op.input.fromGatewayId !== "string" || typeof op.input.uid !== "string") return;
  const gatewayId = op.input.fromGatewayId;
  const native = await deps.prepareNativeComputerReturn({
    fromGatewayId: gatewayId, toGatewayId: user.currentGatewayId,
    uid: op.input.uid, slug: user.slug, operationId: op.id,
  });
  if (!native) return;
  await native.release();
  const url = await deps.resolveGatewayUrl(gatewayId);
  const client = deps.buildClient(() => url);
  await discardSourceFootprint(deps, ctx, { client, gatewayId, slug: user.slug, migrationId: deps.genMigrationId(op.id) });
}

async function prepareMigration(
  deps: MigrateCustomerDeps,
  op: Operation,
  ctx: OperationContext,
  migrationInput: MigrateCustomerInput,
  request: { uid: string; toGatewayId: string },
): Promise<
  | PreparedMigration
  | { result: OperationResult; stateMigration?: RollStateMigrationDecision }
  | { error: string; rolledBack?: false }
> {
  let user: UserGatewayInfo | null;
  try {
    user = await deps.readUser(request.uid);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!user) return { error: `user not found: ${request.uid}` };
  if (
    user.currentGatewayId === request.toGatewayId &&
    isControllerConvergenceSource(migrationInput.source)
  ) {
    await finishNativeReturnAfterCutover(deps, op, ctx, user);
    return { result: { steps: [], success: true, rolledBack: false } };
  }
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
    const automatic = resolveOperationOrigin(op.origin) === "automatic";
    const nativeReturn = await deps.prepareNativeComputerReturn({
      fromGatewayId: resolved.targets.fromGatewayId,
      toGatewayId: resolved.targets.toGatewayId,
      uid: request.uid,
      slug: user.slug,
      operationId: op.id,
    });
    const identityDecision = await decideCustomerStateMigration(deps, resolved.targets);
    const stateMigration = nativeReturnDecision(identityDecision, nativeReturn);
    const durable = await deps.useDurableMigration(
      user.currentGatewayId,
      request.toGatewayId,
    );
    if (stateMigration.strategy === PROVISION_FRESH) {
      return {
        result: await executeProvisionFresh({
          deps,
          ctx,
          op,
          targets: resolved.targets,
          uid: request.uid,
          slug: user.slug,
          migrationId,
          stateMigration,
          automatic,
          durable,
          nativeReturn,
        }),
        stateMigration,
      };
    }
    if (durable) {
      const result = await executeOrdinaryMigrationV2({
        deps,
        op,
        ctx,
        targets: resolved.targets,
        uid: request.uid,
        slug: user.slug,
        migrationId,
      });
      return { result, stateMigration };
    }
    const urls = new Map<string, string>();
    urls.set(
      resolved.targets.fromGatewayId,
      await deps.resolveGatewayUrl(resolved.targets.fromGatewayId),
    );
    urls.set(
      resolved.targets.toGatewayId,
      await deps.resolveGatewayUrl(resolved.targets.toGatewayId),
    );
    const migrationSnapshot = await deps.readUserSnapshot(
      request.uid,
      resolved.targets.toGatewayId,
    );
    if (!migrationSnapshot) {
      return { error: `durable snapshot not found for ${request.uid}` };
    }
    return {
      ...request,
      user,
      migrationId,
      targets: resolved.targets,
      ...(migrationSnapshot.projectCheckoutScope
        ? { projectCheckoutScope: migrationSnapshot.projectCheckoutScope }
        : {}),
      urls,
      stateMigration,
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

async function executeMigration(
  deps: MigrateCustomerDeps,
  ctx: OperationContext,
  prepared: PreparedMigration,
  operationId: string,
  automatic: boolean,
): Promise<OperationResult> {
  const client = deps.buildClient((transportId) => {
    const url = prepared.urls.get(transportId);
    if (!url) {
      throw new Error(`migration client called with unexpected gatewayId: ${transportId}`);
    }
    return url;
  });
  const progress = createMigrationProgress({
    now: deps.now,
    log: (message) => deps.log(`${message} migrationId=${prepared.migrationId} builder=${prepared.user.slug}`),
    send: (event) => deps.reportMigrationProgress(prepared.toGatewayId, {
      ...event,
      migrationId: prepared.migrationId,
      slug: prepared.user.slug,
      source: prepared.user.currentGatewayId,
    }),
  });
  const destinationContext: OperationContext = {
    ...ctx,
    reportStep: async (step) => {
      await ctx.reportStep(step);
      await progress.report(step.name, step.status);
    },
  };
  const result = await runMigration(
    {
      migrationId: prepared.migrationId,
      uid: prepared.uid,
      slug: prepared.user.slug,
      fromGatewayId: prepared.user.currentGatewayId,
      toGatewayId: prepared.toGatewayId,
      crossGateway: prepared.user.currentGatewayId !== prepared.toGatewayId,
      gateAssignment: true,
      projectCheckoutScope: prepared.projectCheckoutScope,
      includeActivationManifest: true,
    },
    buildRunnerDeps({ deps, client, ctx: destinationContext, automatic, operationId }),
  );
  return {
    steps: [],
    success: result.success,
    error: result.errorAt?.error,
    rolledBack: result.rolledBack,
  };
}

async function decideCustomerStateMigration(
  deps: MigrateCustomerDeps,
  targets: MigrationTargets,
): Promise<RollStateMigrationDecision> {
  const [sourceOpenclawVersion, targetArtifact] = await Promise.all([
    deps.readGatewayOpenclawVersion(targets.fromGatewayId),
    targets.toRelease === null
      ? Promise.resolve(null)
      : deps.readGatewayReleaseArtifact(targets.toGatewayId, targets.toRelease),
  ]);
  if (targetArtifact === null || targets.toRelease === null) {
    throw new Error(
      `target gateway ${targets.toGatewayId} has no valid release identity for ` +
      `${targets.toRelease ?? "unknown"}`,
    );
  }
  const decision = decideRollStateMigration({
    sourceOpenclawVersion,
    targetOpenclawVersion: openclawVersionFromGatewayImageTag(targetArtifact.imageTag),
    targetOpenclawSourceSha: targetArtifact.openclawSourceSha,
  });
  if (
    decision.sourceOpenclawVersion === null ||
    decision.sourceOpenclawSourceSha === null
  ) {
    throw new Error(
      `source gateway ${targets.fromGatewayId} reports no complete openclaw identity`,
    );
  }
  if (
    decision.targetOpenclawVersion === null ||
    decision.targetOpenclawSourceSha === null
  ) {
    throw new Error(
      `target gateway ${targets.toGatewayId} release ${targets.toRelease} ` +
      "records no complete openclaw identity",
    );
  }
  return decision;
}

function withStateMigration(
  result: OperationResult,
  stateMigration: RollStateMigrationDecision | undefined,
): OperationResult {
  if (!stateMigration) return result;
  return { ...result, output: { ...result.output, stateMigration } };
}

export function createMigrateCustomerHandler(deps: MigrateCustomerDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as MigrateCustomerInput;
    const request = migrationRequest(input);
    if ("error" in request) return failure(request.error);
    const terminal = terminalDurableMigrationResult(deps, op, input, request);
    if (terminal) return terminal;
    const resumed = resumeDurableMigration(deps, op, ctx);
    if (resumed) return resumed;
    const prepared = await prepareMigration(deps, op, ctx, input, request);
    if ("error" in prepared) return failure(prepared.error, prepared.rolledBack);
    if ("result" in prepared) {
      return withStateMigration(prepared.result, prepared.stateMigration);
    }
    return withStateMigration(
      await executeMigration(
        deps,
        ctx,
        prepared,
        op.id,
        resolveOperationOrigin(op.origin) === "automatic",
      ),
      prepared.stateMigration,
    );
  };
}
