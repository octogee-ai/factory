import { sourceTransferBlocksRelease } from '../lib/source-transfer-execution.js';
import type { RetainedSourceContext } from '../lib/retained-source-transfer.js';
import type { SourceTransferExecution } from '@octogee/shared/types/glm';
import { createMigrationProgress } from "../migration-progress.js";
import {
  ADD_CUSTOMER_DEADLINE_MS,
  MIGRATION_VERIFY_COACH_ATTACH_IN_PROGRESS,
  type MigrationProgressRequestBody,
} from "@octogee/shared/types/fleet-controller";
import type { NativeComputerReturn, NativeComputerReturnInput } from "../lib/native-computer-return.js";
import type {
  CustomerMigrationV2GatewayRootFence,
  CustomerMigrationV2State,
  GatewayClass,
  Operation,
  OperationStep,
  SchedulerHandoffState,
  StepStatus,
} from "@octogee/shared/types/glm";
import { resolveOperationOrigin } from "@octogee/shared/types/glm";
import type {
  FleetBrokerProjectCheckoutScope,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import { computerPreemptionError } from "../operation-retry.js";
import { MigrationDrainPendingError, MigrationRpcError, type MigrationClient } from "@octogee/core/fleet-migration-client";
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
  isTargetSchedulerNotReady,
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
const RETAINED_POD = "retained-pod";
const PROVISION_FRESH = "provision-fresh";
const COACH_ATTACH_POLL_MS = 5_000;

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
  | { ok: true; release: number | null; gatewayClass: GatewayClass }
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

  buildClient: (resolveSync: (gatewayId: string) => string, retainedSource?: RetainedSourceContext) => MigrationClient;
  observeSourceTransfer?: (op: Operation) => Promise<SourceTransferExecution | undefined>;
  cleanupSourceTransfer?: (op:Operation,state:CustomerMigrationV2State) => Promise<void>;

  resolveSourcePlacement: (uid: string, currentGatewayId: string) => Promise<SourcePlacement | null>;
  resolveTargetPlacement: (toGatewayId: string) => Promise<PlacementResolution | null>;

  setMigrationPhase?: (input: { uid: string; sourceGatewayId: string; operationId: string; phase: "preparing" | "waiting" | "transferring" | "connecting" }) => Promise<void>;

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
    claimStartedAt?: number;
  }) => Promise<void>;

  // Durable (V2) migration for Builder gateways; the legacy runner
  // covers shared-class customers with no durable target footprint to fence.
  useDurableMigration: (
    fromGatewayId: string,
    toGatewayId: string,
  ) => Promise<boolean>;

  findPreemptedComputer: (gatewayId: string, sinceMs: number) => Promise<string | null>;

  genMigrationId: (operationId: string) => string;

  now: () => number;
  sleep: (ms: number) => Promise<void>;
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
  const initialized = await initializeMigrationV2(input);
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
    strategy: MIGRATE_STATE,
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
  if (sourceTransferBlocksRelease(await deps.observeSourceTransfer?.(execution.input.op))) return {steps:[],success:false,error:"source transfer observation pending: status 503",rolledBack:false};
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
  try {
    if (sourceTransferBlocksRelease(await execution.input.deps.observeSourceTransfer?.(execution.input.op))) return {steps:[],success:false,error:"source transfer observation pending: status 503",rolledBack:false};
  } catch {
    if (execution.input.op.input.sourceTransferMode === RETAINED_POD) return {steps:[],success:false,error:"source transfer observation unavailable: status 503",rolledBack:false};
  }
  if (error instanceof MigrationDrainPendingError) {
    return { steps: [], success: false, waitingForBuilderIdle: true, rolledBack: false };
  }
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
  return phase === "keysSynced" ||
    phase === "preSynced" ||
    phase === "sourceQuiesced" ||
    phase === "finalSynced";
}

async function runOrdinaryV2Iteration(
  execution: OrdinaryV2Execution,
): Promise<OperationResult | "continue" | "stop"> {
  if (execution.input.op.input.sourceTransferMode === RETAINED_POD) {
    if (!execution.input.ctx.assertActiveClaim) throw new Error('retained source requires active claim verification');
    await execution.input.ctx.assertActiveClaim(true);
  }
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
    if (isAbortPhase(execution.state.phase) && execution.input.op.input.sourceTransferMode===RETAINED_POD) {
      if (!execution.input.deps.cleanupSourceTransfer) throw new Error('retained source cleanup unavailable');
      await execution.input.deps.cleanupSourceTransfer(execution.input.op,execution.state);
    }
    const driverDeps = await buildV2DriverDeps(
      execution.state,
      execution.input.deps,
      execution.input.op,
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
    await execution.progress.report(phase, error instanceof MigrationDrainPendingError ? "pending" : "failed");
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
  "initialized", "keysSynced", "preSynced",
]);
const V2_BOTH_TRANSPORT_PHASES = new Set<CustomerMigrationV2State["phase"]>([
  "sourceQuiesced", "cutover", "abortIntent",
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

function requiredClaimStartedAt(op: Operation): number {
  if (typeof op.startedAt !== 'number' || !Number.isSafeInteger(op.startedAt) || op.startedAt <= 0) throw new Error('retained source requires a current claim timestamp');
  return op.startedAt;
}

async function buildV2DriverDeps(
  state: CustomerMigrationV2State,
  deps: MigrateCustomerDeps,
  op: Operation,
  automatic: boolean,
) {
  const claimFence = op.input.sourceTransferMode === RETAINED_POD ? {claimStartedAt: requiredClaimStartedAt(op)} : {};
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
  }, op.input.sourceTransferMode === RETAINED_POD ? {op,state} : undefined);
  return {
    client,
    setMigrationPhase: (phase: "preparing" | "waiting" | "transferring" | "connecting") => deps.setMigrationPhase?.({ uid: state.uid, sourceGatewayId: state.sourceGatewayId, operationId: state.operationId, phase }) ?? Promise.resolve(),
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
      deps.commitV2Cutover({ ...fence, uid: state.uid, slug: state.slug, automatic, ...claimFence }),
    now: deps.now,
    log: deps.log,
    wait: deps.sleep,
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
  toGatewayClass: GatewayClass;
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
      toGatewayClass: placement.gatewayClass,
      fromGatewayId: user.currentGatewayId,
      toRelease: placement.release,
      fromRelease: source.release,
      fromEpoch: source.epoch ?? 0,
      sourceAssignmentMode: source.assignmentMode ?? "assigned",
    },
  };
}

async function recordCutoverCommitted(
  deps: MigrateCustomerDeps,
  ctx: OperationContext,
  operationId: string,
): Promise<void> {
  if (!ctx.persistCutoverCommitted) return;
  try {
    await ctx.persistCutoverCommitted(deps.now());
  } catch (error) {
    deps.log(
      `[migrate-customer] ❌ op=${operationId} cutover committed but could not be recorded — the serial lock stays held ` +
      `until this operation completes: ${errorMessage(error)}`,
    );
  }
}

function buildRunnerDeps(
  input: {
    deps: MigrateCustomerDeps;
    client: MigrationClient;
    ctx: OperationContext;
    automatic: boolean;
    operationId: string;
    uid: string;
    sourceGatewayId: string;
  },
): MigrationRunnerDeps {
  const { deps, client, ctx } = input;
  return {
    client,
    setMigrationPhase: (phase) => deps.setMigrationPhase?.({ uid: input.uid, sourceGatewayId: input.sourceGatewayId, operationId: input.operationId, phase }) ?? Promise.resolve(),
    commitCutover: async (commit) => {
      await deps.commitCutover({ ...commit, automatic: input.automatic });
      await recordCutoverCommitted(deps, ctx, input.operationId);
    },
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
interface FreshProvision {
  deps: MigrateCustomerDeps;
  ctx: OperationContext;
  operationId: string;
  attempt: number;
  targets: MigrationTargets;
  uid: string;
  slug: string;
  migrationId: string;
  stateMigration: RollStateMigrationDecision;
  automatic: boolean;
  nativeReturn?: NativeComputerReturn | null;
}

type SourceAssignment = Omit<Parameters<MigrateCustomerDeps["setAssignmentState"]>[0], "state" | "createIfMissing">;

async function provisionCustomerOnTarget(input: FreshProvision): Promise<OperationResult> {
  const { deps, targets, uid, slug, migrationId, automatic } = input;
  const ctx = destinationProgressContext(input);
  deps.log(
    `[migrate-customer] ${targets.fromGatewayId} → ${targets.toGatewayId} slug=${slug}: ` +
    `provision-fresh (${input.stateMigration.reason})`,
  );
  const handoff = input.nativeReturn ? await persistNativeReturnHandoff(input) : null;
  const client = await gatewayClient(deps, handoff ? [targets.fromGatewayId, targets.toGatewayId] : [targets.fromGatewayId]);
  const step = (name: string, action: () => Promise<unknown>) =>
    reportFreshStep(deps, ctx, name, action);
  const sourceAssignment: SourceAssignment = {
    gatewayId: targets.fromGatewayId,
    uid,
    slug,
    epoch: targets.fromEpoch,
    updatedByOperationId: input.operationId,
    automatic,
  };
  let sourceFenced = false;
  try {
    await deps.setMigrationPhase?.({ uid, sourceGatewayId: targets.fromGatewayId, operationId: input.operationId, phase: "waiting" });
    await step("wait-for-active-work", () => client.quiesce({ migrationId, gatewayId: targets.fromGatewayId, slug, timeoutMs: 30_000, stopMattermost: false }));
    await deps.setMigrationPhase?.({ uid, sourceGatewayId: targets.fromGatewayId, operationId: input.operationId, phase: "transferring" });
    await deps.setAssignmentState({
      ...sourceAssignment,
      state: "quiescing",
      createIfMissing: targets.sourceAssignmentMode === "unassigned-live",
    });
    sourceFenced = true;
    await closeSourceForFreshProvision(input, client, step, handoff);
    await step("cutover-firestore", async () => {
      await deps.commitCutover({
        uid,
        slug,
        toGatewayId: targets.toGatewayId,
        fromGatewayId: targets.fromGatewayId,
        flipMirror: targets.fromGatewayId !== targets.toGatewayId,
        automatic,
      });
      await recordCutoverCommitted(deps, ctx, input.operationId);
    });
  } catch (error) {
    if (error instanceof MigrationDrainPendingError) {
      return deferFreshProvision(input, client, sourceAssignment, handoff, sourceFenced);
    }
    if (input.nativeReturn) {
      const settled = await settleNativeReturnAfterFailure(input, ctx, input.nativeReturn, handoff);
      if (settled) return settled;
    }
    return rollbackFreshProvision({ deps, client, handoff, sourceAssignment, migrationId, slug, error });
  }
  if (input.nativeReturn) return completeNativeReturn(deps, ctx, input.nativeReturn, { ...targets, uid, migrationId, slug, handoff });
  await discardSourceFootprint(deps, ctx, {
    client,
    migrationId,
    gatewayId: targets.fromGatewayId,
    slug,
  });
  return { steps: [], success: true, rolledBack: false };
}

async function deferFreshProvision(
  input: FreshProvision,
  client: MigrationClient,
  sourceAssignment: SourceAssignment,
  handoff: SchedulerHandoffState | null,
  sourceFenced: boolean,
): Promise<OperationResult> {
  const { deps, targets, uid, slug, migrationId, operationId } = input;
  if (sourceFenced && handoff) {
    const failure = await reopenSourceScheduler(deps, client, handoff);
    if (failure) throw new Error(failure);
  }
  if (sourceFenced) await restoreSourceServing(deps, { ...sourceAssignment, state: "serving", createIfMissing: false });
  await client.resume({ migrationId, gatewayId: targets.fromGatewayId, slug });
  await input.nativeReturn?.release();
  await deps.setMigrationPhase?.({ uid, sourceGatewayId: targets.fromGatewayId, operationId, phase: "waiting" });
  return { steps: [], success: false, waitingForBuilderIdle: true, rolledBack: false };
}

async function closeSourceForFreshProvision(
  input: FreshProvision,
  client: MigrationClient,
  step: (name: string, action: () => Promise<unknown>) => Promise<void>,
  handoff: SchedulerHandoffState | null,
): Promise<void> {
  const { targets, slug, migrationId } = input;
  await step("quiesce-source", () => client.quiesce({
    migrationId,
    gatewayId: targets.fromGatewayId,
    slug,
    ...(handoff ? { schedulerHandoff: true, schedulerMigrationId: handoff.migrationId, retainNonportable: true } : {}),
  }));
  if (!input.nativeReturn?.checkpointRequested) {
    await step("flush-source", () => client.flushGateway({
      migrationId,
      gatewayId: targets.fromGatewayId,
      slug,
      reason: input.nativeReturn ? "native-return" : "migration-final",
    }));
  }
  if (handoff) await step("stage-scheduler", () => stagePortableSchedules(input.deps, client, handoff));
  if (input.nativeReturn) await step("checkpoint-native-computer", input.nativeReturn.checkpoint);
}

async function settleNativeReturnAfterFailure(
  input: FreshProvision,
  ctx: OperationContext,
  native: NativeComputerReturn,
  handoff: SchedulerHandoffState | null,
): Promise<OperationResult | null> {
  const { deps, targets, uid, slug, migrationId } = input;
  const current = await deps.readUser(uid);
  if (current?.currentGatewayId === targets.toGatewayId) {
    return completeNativeReturn(deps, ctx, native, { ...targets, uid, migrationId, slug, handoff });
  }
  if (current?.currentGatewayId !== targets.fromGatewayId) {
    throw new Error("native return ownership changed; checkpoint retained");
  }
  await native.release();
  return null;
}

async function rollbackFreshProvision(input: {
  deps: MigrateCustomerDeps;
  client: MigrationClient;
  handoff: SchedulerHandoffState | null;
  sourceAssignment: SourceAssignment;
  migrationId: string;
  slug: string;
  error: unknown;
}): Promise<OperationResult> {
  const { deps, client, handoff, migrationId, slug } = input;
  const cause = errorMessage(input.error);
  if (handoff) {
    const abortFailed = await abortStagedSchedules(deps, client, handoff);
    if (abortFailed) return failure(`${cause}; ${abortFailed}`, false);
  }
  await restoreSourceServing(deps, {
    ...input.sourceAssignment,
    state: "serving",
    createIfMissing: false,
  });
  const unreleased = handoff ? await reopenSourceScheduler(deps, client, handoff) : null;
  await client.resume({ migrationId, gatewayId: input.sourceAssignment.gatewayId, slug });
  if (unreleased) return failure(`${cause}; ${unreleased}`, false);
  return { steps: [], success: false, error: cause, rolledBack: true };
}

async function persistNativeReturnHandoff(input: {
  deps: MigrateCustomerDeps;
  ctx: OperationContext;
  targets: MigrationTargets;
  uid: string;
  slug: string;
  migrationId: string;
  attempt: number;
}): Promise<SchedulerHandoffState> {
  if (!input.ctx.persistSchedulerHandoff) throw new Error("scheduler handoff persistence is required");
  const handoff: SchedulerHandoffState = {
    migrationId: `${input.migrationId}:scheduler:${input.attempt}`,
    fromGatewayId: input.targets.fromGatewayId,
    toGatewayId: input.targets.toGatewayId,
    uid: input.uid,
    slug: input.slug,
  };
  await input.ctx.persistSchedulerHandoff(handoff);
  return handoff;
}

async function gatewayClient(deps: MigrateCustomerDeps, gatewayIds: string[]): Promise<MigrationClient> {
  const urls = new Map(await Promise.all(
    gatewayIds.map(async (gatewayId) => [gatewayId, await deps.resolveGatewayUrl(gatewayId)] as const),
  ));
  return deps.buildClient((transportId) => {
    const url = urls.get(transportId);
    if (!url) throw new Error(`migration client called with unexpected gatewayId: ${transportId}`);
    return url;
  });
}

function retainedJobIds(snapshot: unknown): string[] {
  const ids = (snapshot as { retainedJobIds?: unknown } | null | undefined)?.retainedJobIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new Error("partial scheduler export did not report which host-bound jobs it retained");
  }
  return ids as string[];
}

async function stagePortableSchedules(
  deps: MigrateCustomerDeps,
  client: MigrationClient,
  handoff: SchedulerHandoffState,
): Promise<void> {
  const { migrationId, slug } = handoff;
  const exported = await client.scheduler({ migrationId, slug, gatewayId: handoff.fromGatewayId, phase: "export", retainNonportable: true });
  const retained = retainedJobIds(exported.snapshot);
  deps.log(
    `[migrate-customer] native return ${slug}: portable schedules of ${exported.agentIds.join(", ")} staged on ${handoff.toGatewayId}; ` +
    `host-bound jobs left dormant on ${handoff.fromGatewayId}: ${retained.length ? retained.join(", ") : "none"}`,
  );
  await client.scheduler({
    migrationId, slug, gatewayId: handoff.toGatewayId, phase: "stage", agentIds: exported.agentIds, snapshot: exported.snapshot,
  });
}

async function abortStagedSchedules(
  deps: MigrateCustomerDeps,
  client: MigrationClient,
  handoff: SchedulerHandoffState,
): Promise<string | null> {
  try {
    await client.scheduler({ migrationId: handoff.migrationId, slug: handoff.slug, gatewayId: handoff.toGatewayId, phase: "abort" });
    return null;
  } catch (abortError) {
    const message = `target scheduler abort unconfirmed on ${handoff.toGatewayId}, source left closed: ${errorMessage(abortError)}`;
    deps.log(`[migrate-customer] ⚠ native return ${handoff.slug}: ${message}`);
    return message;
  }
}

async function reopenSourceScheduler(
  deps: MigrateCustomerDeps,
  client: MigrationClient,
  handoff: SchedulerHandoffState,
): Promise<string | null> {
  try {
    await client.scheduler({ migrationId: handoff.migrationId, slug: handoff.slug, gatewayId: handoff.fromGatewayId, phase: "resume" });
    return null;
  } catch (resumeError) {
    const message = `scheduler fence ${handoff.migrationId} on ${handoff.fromGatewayId} not released: ${errorMessage(resumeError)}`;
    deps.log(`[migrate-customer] ⚠ native return ${handoff.slug}: ${message}`);
    return message;
  }
}

async function activateHandedOffSchedules(
  deps: MigrateCustomerDeps,
  native: NativeComputerReturn,
  handoff: SchedulerHandoffState,
): Promise<void> {
  const { migrationId, slug } = handoff;
  try {
    const source = await gatewayClient(deps, [handoff.fromGatewayId]);
    await source.scheduler({ migrationId, slug, gatewayId: handoff.fromGatewayId, phase: "retire" });
  } catch (error) {
    if (!await native.isSourceFencedOff()) throw error;
    deps.log(
      `[migrate-customer] ⚠ native return ${slug}: Compute confirmed the computer stopped before its schedules retired; ` +
      `its exported copies stay fenced under ${migrationId} on ${handoff.fromGatewayId} until an operator retires that handoff: ${errorMessage(error)}`,
    );
  }
  const target = await gatewayClient(deps, [handoff.toGatewayId]);
  await target.scheduler({ migrationId, slug, gatewayId: handoff.toGatewayId, phase: "activate" });
}

interface MigrationExecutionInput {
  deps: MigrateCustomerDeps;
  ctx: OperationContext;
  op: Operation;
  targets: MigrationTargets;
  uid: string;
  slug: string;
  migrationId: string;
  automatic: boolean;
}

function destinationProgressContext(input: Pick<MigrationExecutionInput, "deps" | "ctx" | "targets" | "slug" | "migrationId">): OperationContext {
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
      { name, status: error instanceof MigrationDrainPendingError ? "skipped" : "failed", error: errorMessage(error) },
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
    throw error;
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
    toGatewayClass: state.targetRootFence.gatewayClass,
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

async function recoverPersistedFreshMigration(
  deps: MigrateCustomerDeps,
  op: Operation,
  ctx: OperationContext,
  state: CustomerMigrationV2State,
): Promise<OperationResult> {
  const scopeMatches = [
    state.operationId === op.id,
    state.migrationId === deps.genMigrationId(op.id),
    state.uid === op.input.uid,
    state.targetGatewayId === op.input.toGatewayId,
    op.input.fromGatewayId === undefined || op.input.fromGatewayId === state.sourceGatewayId,
  ].every(Boolean);
  if (!scopeMatches) return failure("persisted fresh migration input changed", false);
  const automatic = resolveOperationOrigin(op.origin) === "automatic";
  try {
    const user = await deps.readUser(state.uid);
    if (!user || user.slug !== state.slug) throw new Error("cannot verify persisted fresh migration owner");
    if (user.currentGatewayId === state.targetGatewayId) {
      await deps.commitV2Cutover({ ...state, strategy: PROVISION_FRESH, automatic });
      const url = await deps.resolveGatewayUrl(state.sourceGatewayId);
      await discardSourceFootprint(deps, ctx, {
        client: deps.buildClient(() => url), gatewayId: state.sourceGatewayId,
        migrationId: state.migrationId, slug: state.slug,
      });
      await persistV2(ctx, { ...state, phase: "complete", completedAt: deps.now() });
      return { steps: [], success: true, rolledBack: false };
    }
    if (user.currentGatewayId !== state.sourceGatewayId) throw new Error("persisted fresh migration ownership changed");
    if (state.phase === "cutover" || state.phase === "sourceRetired") throw new Error("persisted fresh cutover lost target ownership");
    const abortReason = "retired fresh migration cancelled before cutover; retry with durable state transfer";
    await persistV2(ctx, { ...state, phase: "abortIntent", abortReason });
    if (state.sourceAssignmentMode === "assigned") {
      await deps.setAssignmentState({
        gatewayId: state.sourceGatewayId, uid: state.uid, slug: state.slug,
        state: "serving", epoch: state.sourceEpoch, updatedByOperationId: state.operationId,
        createIfMissing: false, automatic,
      });
    }
    await persistV2(ctx, { ...state, phase: "aborted", abortReason });
    return { steps: [], success: false, rolledBack: true, error: abortReason };
  } catch (error) {
    return failure(v2RetryError(error), false);
  }
}

function resumeDurableMigration(
  deps: MigrateCustomerDeps,
  op: Operation,
  ctx: OperationContext,
): Promise<OperationResult> | null {
  const state = op.customerMigrationV2;
  if (!state) return null;
  if (state.strategy === PROVISION_FRESH) return recoverPersistedFreshMigration(deps, op, ctx, state);
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

async function executeProvisionFresh(input: MigrationExecutionInput & {
  stateMigration: RollStateMigrationDecision;
  durable: boolean;
  nativeReturn?: NativeComputerReturn | null;
}): Promise<OperationResult> {
  if (input.nativeReturn && input.durable) throw new Error("native computer returns require a Shared target");
  return provisionCustomerOnTarget({
    deps: input.deps,
    ctx: input.ctx,
    operationId: input.op.id,
    attempt: (input.op.attempts ?? 0) + 1,
    targets: input.targets,
    uid: input.uid,
    slug: input.slug,
    migrationId: input.migrationId,
    stateMigration: input.stateMigration,
    automatic: input.automatic,
    nativeReturn: input.nativeReturn,
  });
}

function nativeReturnDecision(): RollStateMigrationDecision {
  return {
    strategy: PROVISION_FRESH,
    sourceOpenclawVersion: null, targetOpenclawVersion: null,
    sourceOpenclawSourceSha: null, targetOpenclawSourceSha: null,
    reason: "preserve native computer state; provision standard coach on Shared",
  };
}

async function preparedStateMigration(
  deps: MigrateCustomerDeps,
  targets: MigrationTargets,
  native: NativeComputerReturn | null,
): Promise<RollStateMigrationDecision> {
  return native ? nativeReturnDecision() : decideCustomerStateMigration(deps, targets);
}

async function completeNativeReturn(
  deps: MigrateCustomerDeps,
  ctx: OperationContext,
  native: NativeComputerReturn,
  input: { uid: string; fromGatewayId: string; toGatewayId: string; slug: string; migrationId: string; handoff: SchedulerHandoffState | null },
): Promise<OperationResult> {
  try {
    await ctx.assertCustomerRestoreSettled?.();
    await native.release();
    if (input.handoff) {
      const handoff = input.handoff;
      await reportFreshStep(deps, ctx, "activate-scheduler", () => activateHandedOffSchedules(deps, native, handoff));
    }
    await reportFreshStep(deps, ctx, "unmount-source", async () => {
      try {
        const url = await deps.resolveGatewayUrl(input.fromGatewayId);
        await deps.buildClient(() => url).unmount({
          migrationId: input.migrationId, gatewayId: input.fromGatewayId, slug: input.slug,
        });
      } catch (error) {
        if (!await native.isSourceFencedOff()) throw error;
        deps.log(`native return ${input.slug}: paused/retired source confirmed stopped by Compute; cleanup RPC skipped: ${errorMessage(error)}`);
      }
    });
    await reportFreshStep(deps, ctx, "verify-target", () => verifyOrRestoreNativeReturnTarget(deps, ctx, input));
    return { steps: [], success: true, rolledBack: false };
  } catch (error) {
    return failure(`native return completion pending: status 503: ${errorMessage(error)}`, false);
  }
}

interface NativeReturnTarget {
  uid: string;
  fromGatewayId: string;
  toGatewayId: string;
  slug: string;
  migrationId: string;
}

function interruptedSharedMount(error: unknown, input: NativeReturnTarget): boolean {
  if (!(error instanceof MigrationRpcError) || error.status !== 409 || error.code !== undefined) return false;
  const body = error.details;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const details = body as Record<string, unknown>;
  const checks = details.checks;
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) return false;
  const readiness = checks as Record<string, unknown>;
  return [
    details.migrationId === input.migrationId, details.slug === input.slug, details.ready === false,
    details.code === undefined,
    details.configTransferMode === undefined || details.configTransferMode === "activation-manifest",
    readiness.customerDir === true, readiness.coachWired === true,
    readiness.mountMarked === false, readiness.accountHealthy === true,
  ].every(Boolean);
}

async function restoreInterruptedSharedMount(
  deps: MigrateCustomerDeps,
  ctx: OperationContext,
  input: NativeReturnTarget,
): Promise<void> {
  const url = await deps.resolveGatewayUrl(input.toGatewayId);
  const snapshot = await deps.readUserSnapshot(input.uid, input.toGatewayId);
  if (!snapshot || snapshot.uid !== input.uid || snapshot.slug !== input.slug ||
      snapshot.gatewayId !== input.toGatewayId || snapshot.status !== "complete") {
    throw new Error("Shared restore snapshot no longer proves the assigned complete owner");
  }
  if (!ctx.assertActiveClaim) throw new Error("Shared restore requires an active operation claim check");
  if (!ctx.withCustomerRestoreFence) throw new Error("Shared restore requires durable assignment coordination");
  const placement = await deps.resolveSourcePlacement(input.uid, input.toGatewayId);
  if (placement?.epoch === undefined) throw new Error("Shared restore requires an assigned epoch");
  await ctx.assertActiveClaim();
  await ctx.withCustomerRestoreFence({
    uid: input.uid, slug: input.slug, gatewayId: input.toGatewayId,
    fromGatewayId: input.fromGatewayId, assignmentEpoch: placement.epoch,
  }, () => reportFreshStep(deps, ctx, "restore-target", async () => {
    const result = await deps.buildClient(() => url).restoreTarget({
      migrationId: input.migrationId, gatewayId: input.toGatewayId,
      uid: input.uid, slug: input.slug, snapshot,
    });
    if (result.restored !== true || result.migrationId !== input.migrationId || result.slug !== input.slug) {
      throw new Error("Shared restore did not confirm the matching migration");
    }
  }));
  await ctx.assertActiveClaim();
  const owner = await deps.readUser(input.uid);
  if (owner?.slug !== input.slug || owner.currentGatewayId !== input.toGatewayId) {
    throw new Error("Shared restore owner changed before verification");
  }
}

async function verifyOrRestoreNativeReturnTarget(
  deps: MigrateCustomerDeps,
  ctx: OperationContext,
  input: NativeReturnTarget,
): Promise<void> {
  try {
    await verifyNativeReturnTarget(deps, input);
    return;
  } catch (error) {
    if (!interruptedSharedMount(error, input)) throw error;
  }
  await restoreInterruptedSharedMount(deps, ctx, input);
  await verifyNativeReturnTarget(deps, input);
}

function coachAttachInProgress(error: unknown): boolean {
  return error instanceof MigrationRpcError && error.code === MIGRATION_VERIFY_COACH_ATTACH_IN_PROGRESS;
}

async function verifyNativeReturnTarget(
  deps: MigrateCustomerDeps,
  input: { toGatewayId: string; slug: string; migrationId: string },
): Promise<void> {
  const url = await deps.resolveGatewayUrl(input.toGatewayId);
  const client = deps.buildClient(() => url);
  const deadline = deps.now() + ADD_CUSTOMER_DEADLINE_MS;
  for (;;) {
    try {
      const result = await client.verifyTarget({
        migrationId: input.migrationId, gatewayId: input.toGatewayId, slug: input.slug,
      });
      if (!result.ready) throw new Error(`Shared coach ${input.slug} is not ready`);
      return;
    } catch (error) {
      if (!coachAttachInProgress(error) || deps.now() >= deadline) throw error;
      deps.log(`native return ${input.slug}: ${input.toGatewayId} is still attaching the coach; verifying again`);
      await deps.sleep(COACH_ATTACH_POLL_MS);
    }
  }
}

async function finishNativeReturnAfterCutover(
  deps: MigrateCustomerDeps,
  op: Operation,
  ctx: OperationContext,
  user: UserGatewayInfo,
  request: { uid: string; toGatewayId: string },
): Promise<OperationResult | null> {
  if (typeof op.input.fromGatewayId !== "string") return null;
  const fromGatewayId = op.input.fromGatewayId;
  const native = await deps.prepareNativeComputerReturn({
    fromGatewayId, toGatewayId: user.currentGatewayId, uid: request.uid, slug: user.slug, operationId: op.id,
  });
  if (!native) return null;
  const handoff = op.schedulerHandoff ?? null;
  if (handoff && (
    handoff.uid !== request.uid || handoff.slug !== user.slug ||
    handoff.fromGatewayId !== fromGatewayId || handoff.toGatewayId !== user.currentGatewayId
  )) {
    return failure("scheduler handoff scope changed after cutover", false);
  }
  return completeNativeReturn(deps, ctx, native, {
    uid: request.uid, fromGatewayId, toGatewayId: user.currentGatewayId, slug: user.slug, migrationId: deps.genMigrationId(op.id), handoff,
  });
}

async function stageAfterCutover(
  deps: MigrateCustomerDeps,
  ctx: OperationContext,
  client: MigrationClient,
  handoff: SchedulerHandoffState,
): Promise<void> {
  if (!handoff.stageAfterCutover || handoff.stagedAt !== undefined) return;
  if (!ctx.persistSchedulerHandoff) throw new Error("scheduler handoff persistence is required");
  const { migrationId, slug } = handoff;
  const exported = await client.scheduler({ migrationId, slug, gatewayId: handoff.fromGatewayId, phase: "export" });
  await client.scheduler({
    migrationId, slug, gatewayId: handoff.toGatewayId, phase: "stage",
    agentIds: exported.agentIds, snapshot: exported.snapshot, retainNonportable: true,
  });
  await ctx.persistSchedulerHandoff({ ...handoff, stagedAt: deps.now() });
}

async function completeSchedulerHandoff(
  deps: MigrateCustomerDeps,
  op: Operation,
  ctx: OperationContext,
  user: UserGatewayInfo,
  request: { uid: string; toGatewayId: string },
): Promise<OperationResult> {
  const handoff = op.schedulerHandoff!;
  if (handoff.uid !== request.uid || handoff.slug !== user.slug || handoff.toGatewayId !== request.toGatewayId) {
    return failure("scheduler handoff scope changed after cutover", false);
  }
  let client: MigrationClient;
  try {
    client = await gatewayClient(deps, [handoff.fromGatewayId, handoff.toGatewayId]);
    await stageAfterCutover(deps, ctx, client, handoff);
    await client.scheduler({ migrationId: handoff.migrationId, slug: handoff.slug, gatewayId: handoff.fromGatewayId, phase: "retire" });
    await client.scheduler({ migrationId: handoff.migrationId, slug: handoff.slug, gatewayId: handoff.toGatewayId, phase: "activate" });
  } catch (error) {
    return failure(`scheduler handoff cleanup pending: ${errorMessage(error)}`, false);
  }
  await unmountSourceAfterCutover(deps, client, { migrationId: deps.genMigrationId(op.id), slug: handoff.slug, gatewayId: handoff.fromGatewayId });
  return { steps: [], success: true, rolledBack: false };
}

async function unmountSourceAfterCutover(
  deps: MigrateCustomerDeps,
  client: MigrationClient,
  source: { migrationId: string; slug: string; gatewayId: string },
): Promise<void> {
  try {
    await client.unmount(source);
  } catch (error) {
    deps.log(
      `[migrate-customer] ⚠ unmount-source cleanup failed after durable cutover migrationId=${source.migrationId} ` +
      `slug=${source.slug} source=${source.gatewayId}: ${errorMessage(error)} — target remains serving`,
    );
  }
}

async function resumePreviousSchedulerAttempt(
  deps: MigrateCustomerDeps,
  op: Operation,
  user: UserGatewayInfo,
  uid: string,
): Promise<void> {
  const previous = op.schedulerHandoff;
  if (!previous || previous.migrationId === `${deps.genMigrationId(op.id)}:scheduler:${(op.attempts ?? 0) + 1}`) return;
  if (previous.fromGatewayId !== user.currentGatewayId || previous.uid !== uid || previous.slug !== user.slug) {
    throw new Error("scheduler rollback scope changed");
  }
  if (!previous.stageAfterCutover) await abortPreviousTargetAttempt(deps, previous);
  const url = await deps.resolveGatewayUrl(previous.fromGatewayId);
  await deps.buildClient(() => url).scheduler({
    migrationId: previous.migrationId, slug: previous.slug, gatewayId: previous.fromGatewayId, phase: "resume",
  });
}

async function abortPreviousTargetAttempt(deps: MigrateCustomerDeps, previous: SchedulerHandoffState): Promise<void> {
  const url = await deps.resolveGatewayUrl(previous.toGatewayId);
  try {
    await deps.buildClient(() => url).scheduler({
      migrationId: previous.migrationId, slug: previous.slug, gatewayId: previous.toGatewayId, phase: "abort",
    });
  } catch (error) {
    if (!isTargetSchedulerNotReady(error)) throw error;
    throw new Error(
      `target gateway ${previous.toGatewayId} scheduler did not become ready to abort ${previous.migrationId}: ${errorMessage(error)}`,
    );
  }
}

async function recoverCommittedMigration(
  deps: MigrateCustomerDeps,
  op: Operation,
  ctx: OperationContext,
  user: UserGatewayInfo,
  request: { uid: string; toGatewayId: string },
): Promise<OperationResult | null> {
  if (user.currentGatewayId !== request.toGatewayId) return null;
  const convergence = isControllerConvergenceSource(op.input.source);
  if (convergence) {
    const nativeReturn = await finishNativeReturnAfterCutover(deps, op, ctx, user, request);
    if (nativeReturn) return nativeReturn;
  }
  if (op.schedulerHandoff) return completeSchedulerHandoff(deps, op, ctx, user, request);
  return convergence ? { steps: [], success: true, rolledBack: false } : null;
}

function assertRetainedMigrationStrategy(op: Operation, durable: boolean, stateMigration: RollStateMigrationDecision, nativeReturn: NativeComputerReturn | null): void {
  if (op.input.sourceTransferMode === RETAINED_POD && (!durable || stateMigration.strategy === PROVISION_FRESH || nativeReturn)) throw new Error('retained source transfer requires an ordinary durable migration');
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
  const recovered = await recoverCommittedMigration(deps, op, ctx, user, request);
  if (recovered) return { result: recovered };
  if (op.cutoverCommittedAt !== undefined) {
    return {
      error:
        `migration cutover already committed to ${request.toGatewayId}; customer now owned by ${user.currentGatewayId} — ` +
        "source cleanup left to the eviction sweep",
      rolledBack: false,
    };
  }
  const migrationId = deps.genMigrationId(op.id);

  try {
    await resumePreviousSchedulerAttempt(deps, op, user, request.uid);
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
    const stateMigration = await preparedStateMigration(deps, resolved.targets, nativeReturn);
    const durable = await deps.useDurableMigration(
      user.currentGatewayId,
      request.toGatewayId,
    );
    assertRetainedMigrationStrategy(op,durable,stateMigration,nativeReturn);
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
  op: Operation,
): Promise<OperationResult> {
  const operationId = op.id;
  const automatic = resolveOperationOrigin(op.origin) === "automatic";
  const attempt = (op.attempts ?? 0) + 1;
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
  const schedulerMigrationId = `${prepared.migrationId}:scheduler:${attempt}`;
  const persistSchedulerHandoff = ctx.persistSchedulerHandoff;
  if (!persistSchedulerHandoff) throw new Error("scheduler handoff persistence is required");
  const heldTarget = prepared.targets.toGatewayClass === "builder";
  const handoff: SchedulerHandoffState = {
    migrationId: schedulerMigrationId,
    fromGatewayId: prepared.user.currentGatewayId,
    toGatewayId: prepared.toGatewayId,
    uid: prepared.uid,
    slug: prepared.user.slug,
    ...(heldTarget ? { stageAfterCutover: true as const } : {}),
  };
  await persistSchedulerHandoff(handoff);
  const result = await runMigration(
    {
      migrationId: prepared.migrationId,
      schedulerMigrationId,
      uid: prepared.uid,
      slug: prepared.user.slug,
      fromGatewayId: prepared.user.currentGatewayId,
      toGatewayId: prepared.toGatewayId,
      crossGateway: prepared.user.currentGatewayId !== prepared.toGatewayId,
      acceptRetainedTargetJobs: heldTarget,
      stageSchedulesAfterCutover: heldTarget,
      gateAssignment: true,
      projectCheckoutScope: prepared.projectCheckoutScope,
      includeActivationManifest: true,
    },
    {
      ...buildRunnerDeps({ deps, client, ctx: destinationContext, automatic, operationId, uid: prepared.uid, sourceGatewayId: prepared.user.currentGatewayId }),
      recordSchedulesStaged: () => persistSchedulerHandoff({ ...handoff, stagedAt: deps.now() }),
    },
  );
  return {
    steps: [],
    success: result.success,
    error: result.errorAt?.error,
    ...(result.waitingForBuilderIdle ? { waitingForBuilderIdle: true } : {}),
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
  return decideRollStateMigration({
    sourceOpenclawVersion,
    targetOpenclawVersion: openclawVersionFromGatewayImageTag(targetArtifact.imageTag),
    targetOpenclawSourceSha: targetArtifact.openclawSourceSha,
  });
}

function withStateMigration(
  result: OperationResult,
  stateMigration: RollStateMigrationDecision | undefined,
): OperationResult {
  if (!stateMigration) return result;
  return { ...result, output: { ...result.output, stateMigration } };
}

async function runMigrateCustomer(
  deps: MigrateCustomerDeps,
  op: Operation,
  ctx: OperationContext,
): Promise<OperationResult> {
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
      op,
    ),
    prepared.stateMigration,
  );
}

function migrationComputers(op: Operation): Array<["source" | "target", string]> {
  const input = op.input as MigrateCustomerInput;
  const sourceGatewayId = typeof input.fromGatewayId === "string"
    ? input.fromGatewayId
    : op.customerMigrationV2?.sourceGatewayId;
  return [
    ...(typeof input.toGatewayId === "string" ? [["target", input.toGatewayId] as ["target", string]] : []),
    ...(sourceGatewayId ? [["source", sourceGatewayId] as ["source", string]] : []),
  ];
}

async function preemptedComputer(
  deps: MigrateCustomerDeps,
  op: Operation,
): Promise<{ role: "source" | "target"; instanceName: string } | null> {
  const since = op.firstStartedAt ?? op.startedAt;
  if (typeof since !== "number") return null;
  for (const [role, gatewayId] of migrationComputers(op)) {
    try {
      const instanceName = await deps.findPreemptedComputer(gatewayId, since);
      if (instanceName) return { role, instanceName };
    } catch (error) {
      deps.log(`[migrate-customer] ⚠ op=${op.id} could not check whether ${gatewayId}'s computer was preempted: ${errorMessage(error)}`);
    }
  }
  return null;
}

async function attributePreemption(
  deps: MigrateCustomerDeps,
  op: Operation,
  result: OperationResult,
): Promise<OperationResult> {
  if (result.success) return result;
  const preempted = await preemptedComputer(deps, op);
  if (!preempted) return result;
  return {
    ...result,
    error: computerPreemptionError(preempted.role, preempted.instanceName, result.error ?? "migration failed"),
  };
}

export function createMigrateCustomerHandler(deps: MigrateCustomerDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    if (op.input.sourceTransferMode !== undefined && op.input.sourceTransferMode !== RETAINED_POD) throw new Error('unsupported source transfer mode');
    if (op.input.sourceTransferMode === RETAINED_POD && (!deps.observeSourceTransfer || (typeof op.input.fromGatewayId !== 'string' || !op.input.fromGatewayId.startsWith('shared-')))) throw new Error('retained source transfer requires a Shared source');
    return attributePreemption(deps, op, await runMigrateCustomer(deps, op, ctx));
  };
}
