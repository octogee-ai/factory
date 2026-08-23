import type { AssignmentState } from "@octogee/shared/types/gateway-releases";
import type { OperationStatus } from "@octogee/shared/types/glm";
import type {
  MigrationConfigTransferMode,
  MigrationLoadStrategy,
} from "@octogee/shared/types/fleet-controller";
import { gatewayHeartbeatMatchesImageTag } from "@octogee/shared/types/image-tag";
import type { RollStateMigrationDecision } from "./roll-state-migration.js";

export interface SurgePod {
  uid: string;
  name: string;
  podIP: string;
  ready: boolean;
  terminating: boolean;
}

export interface SurgePodSnapshot {
  pods: readonly SurgePod[];
  observedPodUids: readonly string[];
}

export type SurgePrelaunchState = "none" | "held" | "hydrated" | "starting" | "serving";
export type SurgeFleetSignatureCapability = "gateway-scoped" | "legacy";

export interface SurgePodHealth {
  status: "booting" | "ready";
  version: string;
  fleetSignatureCapability: SurgeFleetSignatureCapability;
  handoffReleased: boolean;
  prelaunchState: SurgePrelaunchState;
  mountedCustomers: readonly string[];
}

export interface SurgeAssignment {
  uid: string;
  slug: string;
  state: AssignmentState;
  epoch: number;
  updatedByOperationId: string | null;
}

export function assertSurgeAssignmentCoverage(
  assignments: readonly SurgeAssignment[],
  users: ReadonlyArray<{ uid: string; slug: string }>,
): void {
  const assignmentByUid = new Map(assignments.map((item) => [item.uid, item]));
  const userByUid = new Map(users.map((item) => [item.uid, item]));
  for (const user of users) {
    const assignment = assignmentByUid.get(user.uid);
    if (!assignment || assignment.slug !== user.slug) {
      throw new Error(`missing assignment for assigned user ${user.uid}/${user.slug}`);
    }
  }
  for (const assignment of assignments) {
    const user = userByUid.get(assignment.uid);
    if (!user || user.slug !== assignment.slug) {
      throw new Error(`orphan assignment ${assignment.uid}/${assignment.slug}`);
    }
  }
}

interface SessionDigest {
  fileCount: number;
  totalBytes: number;
  sha256: string;
}

class SurgeTargetCleanupError extends Error {}

// A source pod whose image predates the OpenClaw process gate cannot stop its
// own OpenClaw on request. It still quiesces and flushes, so the handoff
// degrades to the pre-gate contract for that one roll instead of wedging the
// gateway on its own image forever.
export class SurgeOpenClawProcessEndpointMissingError extends Error {}
export class SurgeGatewayScopedSignatureCapabilityMissingError extends Error {}

const SYSTEM_CONFIG_COMMIT = /^[0-9a-f]{40,64}$/;
const CONFIGURED_BUILDER_TARGET_RELEASE_RETRY_DELAY_MS = 7_000;

export interface SurgeCustomerHandoffDeps {
  listPods: (gatewayId: string) => Promise<SurgePodSnapshot>;
  readPodHealth: (pod: SurgePod, gatewayId: string) => Promise<SurgePodHealth | null>;
  readAssignments: (gatewayId: string) => Promise<SurgeAssignment[]>;
  markAssignment: (input: {
    gatewayId: string;
    uid: string;
    slug: string;
    epoch: number;
    state: "serving" | "quiescing";
    updatedByOperationId: string;
    expected: {
      state: AssignmentState;
      updatedByOperationId: string | null;
    };
  }) => Promise<void>;
  quiesce: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    sourcePod: SurgePod;
  }) => Promise<void>;
  stopSourceOpenClaw?: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    sourcePod: SurgePod;
    targetPod: SurgePod;
  }) => Promise<void>;
  resumeSourceOpenClaw?: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    sourcePod: SurgePod;
    targetPod: SurgePod;
  }) => Promise<void>;
  holdTargetOpenClaw?: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    targetPod: SurgePod;
  }) => Promise<void>;
  unreserveTargetOpenClaw?: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    targetPod: SurgePod;
  }) => Promise<void>;
  flush: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    pod: SurgePod;
    reason: "migration-final" | "migration-converge";
    expectedSystemConfigCommit?: string;
  }) => Promise<{ systemConfigCommit?: string }>;
  transfer: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    sourcePod: SurgePod;
    targetPod: SurgePod;
    loadStrategy: MigrationLoadStrategy;
    configTransferMode: MigrationConfigTransferMode;
    expectedSystemConfigCommit?: string;
  }) => Promise<void>;
  discardTargetCustomer: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    targetPod: SurgePod;
  }) => Promise<void>;
  readDurableSessionDigest: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    pod: SurgePod;
    configTransferMode: MigrationConfigTransferMode;
  }) => Promise<SessionDigest>;
  releaseTarget: (input: {
    gatewayId: string;
    operationId: string;
    pod: SurgePod;
  }) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
  readOwnerOperation: (operationId: string) => Promise<{ status: OperationStatus } | null>;
  log: (message: string) => void;
}

export interface ReconcileSurgeCustomerHandoffInput {
  gatewayId: string;
  desiredImageTag: string;
  requiresCustomerMigration: boolean;
  disposableBuilderGateway?: boolean;
  ownerlessOperatorPrewarm?: boolean;
  stateMigration: RollStateMigrationDecision;
  /** Image tag a queued rollout will put on this gateway, when it replaces the current one. */
  supersedingImageTag?: string;
}

function configTransferModeFor(
  input: Pick<ReconcileSurgeCustomerHandoffInput, "disposableBuilderGateway">,
): MigrationConfigTransferMode {
  return input.disposableBuilderGateway === true
    ? "configured-builder-system-config"
    : "activation-manifest";
}

function configuredBuilderProcessGateRequired(
  input: Pick<ReconcileSurgeCustomerHandoffInput, "disposableBuilderGateway">,
): boolean {
  return configTransferModeFor(input) === "configured-builder-system-config";
}

function prelaunchTransferEligible(health: SurgePodHealth): boolean {
  return health.prelaunchState === "held" || health.prelaunchState === "hydrated";
}

async function stopSourceOpenClaw(
  deps: SurgeCustomerHandoffDeps,
  input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    sourcePod: SurgePod;
    targetPod: SurgePod;
  },
): Promise<void> {
  if (!deps.stopSourceOpenClaw) {
    throw new Error("configured Builder source lacks the required surge OpenClaw hold capability");
  }
  await deps.stopSourceOpenClaw(input);
}

async function resumeSourceOpenClaw(
  deps: SurgeCustomerHandoffDeps,
  input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    sourcePod: SurgePod;
    targetPod: SurgePod;
  },
): Promise<void> {
  if (!deps.resumeSourceOpenClaw) {
    throw new Error("configured Builder source lacks the required surge OpenClaw resume capability");
  }
  await deps.resumeSourceOpenClaw(input);
}

async function holdTargetOpenClaw(
  deps: SurgeCustomerHandoffDeps,
  input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    targetPod: SurgePod;
  },
): Promise<void> {
  if (!deps.holdTargetOpenClaw) {
    throw new Error("configured Builder target lacks the required surge OpenClaw reserve capability");
  }
  await deps.holdTargetOpenClaw(input);
}

function requireSystemConfigCommit(
  systemConfigCommit: string | undefined,
  slug: string,
): string {
  if (typeof systemConfigCommit === "string" && SYSTEM_CONFIG_COMMIT.test(systemConfigCommit)) {
    return systemConfigCommit;
  }
  throw new Error(`Builder handoff source flush did not return a system config commit for ${slug}`);
}

function operationId(gatewayId: string, targetPodUid: string): string {
  return `surge-${gatewayId}-${targetPodUid}`;
}

const SURGE_OPERATION_ID_RE =
  /^surge-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

function isSurgeOwnerForGateway(owner: string, gatewayId: string): boolean {
  return SURGE_OPERATION_ID_RE.exec(owner)?.[1] === gatewayId;
}

// A quiescing assignment is a lease. Surge leases name a pod uid, so pod observation
// decides liveness; every other owner is an operations-collection id, and one that is
// gone or terminal will never release its own lease.
async function abandonedLeaseReason(
  deps: SurgeCustomerHandoffDeps,
  gatewayId: string,
  owner: string,
  context: {
    liveSurgeOwners: ReadonlySet<string>;
    reclaimableOwners: ReadonlySet<string>;
  },
): Promise<string | null> {
  if (SURGE_OPERATION_ID_RE.test(owner)) {
    if (!isSurgeOwnerForGateway(owner, gatewayId)) return null;
    if (context.reclaimableOwners.has(owner)) return "prior surge target is now the source";
    return context.liveSurgeOwners.has(owner) ? null : "owning surge pod is gone";
  }
  const operation = await deps.readOwnerOperation(owner);
  if (!operation) return "owning operation no longer exists";
  return operation.status === "pending" || operation.status === "running"
    ? null
    : `owning operation is ${operation.status}`;
}

function selectTarget(
  pods: readonly SurgePod[],
  healthByUid: ReadonlyMap<string, SurgePodHealth>,
  desiredImageTag: string,
): SurgePod | null {
  const desired = pods.filter((pod) => !pod.terminating && gatewayHeartbeatMatchesImageTag(
    healthByUid.get(pod.uid)?.version,
    desiredImageTag,
  ));
  const blocked = desired.filter((pod) => !pod.ready);
  if (blocked.length === 1) return blocked[0];
  if (blocked.length > 1) {
    throw new Error(`multiple blocked replacement pods report desired image ${desiredImageTag}`);
  }
  if (desired.length === 1) return desired[0];
  return null;
}

function assertAssignmentsAvailable(
  assignments: readonly SurgeAssignment[],
  ownedBy: string,
): void {
  const foreign = assignments.find((item) =>
    item.state !== "serving" &&
    !(item.state === "quiescing" && item.updatedByOperationId === ownedBy));
  if (foreign) {
    throw new Error(
      `foreign assignment gate for ${foreign.uid}/${foreign.slug}: ` +
      `state=${foreign.state} owner=${foreign.updatedByOperationId ?? "none"}`,
    );
  }
}

async function setAssignmentState(
  deps: SurgeCustomerHandoffDeps,
  gatewayId: string,
  assignment: SurgeAssignment,
  state: "serving" | "quiescing",
  ownedBy: string,
): Promise<void> {
  await deps.markAssignment({
    gatewayId,
    uid: assignment.uid,
    slug: assignment.slug,
    epoch: assignment.epoch,
    state,
    updatedByOperationId: ownedBy,
    expected: {
      state: assignment.state,
      updatedByOperationId: assignment.updatedByOperationId,
    },
  });
}

async function gateServingAssignments(
  deps: SurgeCustomerHandoffDeps,
  gatewayId: string,
  assignments: readonly SurgeAssignment[],
  ownedBy: string,
): Promise<void> {
  for (const assignment of assignments) {
    if (assignment.state !== "serving") continue;
    await setAssignmentState(deps, gatewayId, assignment, "quiescing", ownedBy);
    assignment.state = "quiescing";
    assignment.updatedByOperationId = ownedBy;
  }
}

async function restoreOwnedAssignments(
  deps: SurgeCustomerHandoffDeps,
  gatewayId: string,
  assignments: readonly SurgeAssignment[],
  ownedBy: string,
): Promise<void> {
  for (const assignment of assignments) {
    if (assignment.state === "quiescing" && assignment.updatedByOperationId === ownedBy) {
      await setAssignmentState(deps, gatewayId, assignment, "serving", ownedBy);
      assignment.state = "serving";
      assignment.updatedByOperationId = ownedBy;
    }
  }
}

async function restoreAbandonedSurgeAssignments(
  deps: SurgeCustomerHandoffDeps,
  gatewayId: string,
  assignments: readonly SurgeAssignment[],
  ownedBy: string | null,
  context: {
    observedPodUids: readonly string[];
    reclaimableOwners?: ReadonlySet<string>;
  },
): Promise<void> {
  const { observedPodUids, reclaimableOwners = new Set() } = context;
  const liveSurgeOwners = new Set(observedPodUids.map((uid) => operationId(gatewayId, uid)));
  for (const assignment of assignments) {
    const priorOwner = assignment.updatedByOperationId;
    if (assignment.state !== "quiescing" || priorOwner === null || priorOwner === ownedBy) {
      continue;
    }
    const reason = await abandonedLeaseReason(deps, gatewayId, priorOwner, {
      liveSurgeOwners,
      reclaimableOwners,
    });
    if (!reason) continue;
    deps.log(
      `[surge-handoff] restoring abandoned assignment ` +
      `gateway=${gatewayId} uid=${assignment.uid} owner=${priorOwner}: ${reason}`,
    );
    const recoveryOwner = ownedBy ?? priorOwner;
    await setAssignmentState(deps, gatewayId, assignment, "serving", recoveryOwner);
    assignment.state = "serving";
    assignment.updatedByOperationId = recoveryOwner;
  }
}

function sameDigest(left: SessionDigest, right: SessionDigest): boolean {
  return left.fileCount === right.fileCount &&
    left.totalBytes === right.totalBytes &&
    left.sha256 === right.sha256;
}

function describeDigest(digest: SessionDigest): string {
  return `files=${digest.fileCount} bytes=${digest.totalBytes} sha256=${digest.sha256}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function discardTargetCustomers(
  deps: SurgeCustomerHandoffDeps,
  context: {
    gatewayId: string;
    operationId: string;
    targetPod: SurgePod;
    slugs: readonly string[];
    cause?: unknown;
  },
): Promise<void> {
  const failures: string[] = [];
  for (const slug of [...new Set(context.slugs)].reverse()) {
    try {
      await deps.discardTargetCustomer({
        gatewayId: context.gatewayId,
        slug,
        operationId: context.operationId,
        targetPod: context.targetPod,
      });
    } catch (error) {
      failures.push(`${slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new SurgeTargetCleanupError(
      `surge target cleanup failed; admission remains closed: ${failures.join("; ")}`,
      { cause: context.cause },
    );
  }
}

// The configured Builder source finalization contract:
// quiesce → final durable flush → reserve target → stop source → copy → verify.
// The flush runs while the source still serves so a flush failure never costs
// availability; the reservation lands before the source stops so the target can
// never self-release into a half-copied state; the copy begins only after the
// source process exits so the digests compare frozen state.
interface AssignmentTransferContext {
  input: ReconcileSurgeCustomerHandoffInput;
  sourcePod: SurgePod;
  targetPod: SurgePod;
  ownedBy: string;
  heldSourceSlugs: string[];
}

async function finalizeSourceForAssignment(
  deps: SurgeCustomerHandoffDeps,
  context: AssignmentTransferContext,
  assignment: SurgeAssignment,
): Promise<string | undefined> {
  const { input, sourcePod, targetPod, ownedBy, heldSourceSlugs } = context;
  await deps.quiesce({
    gatewayId: input.gatewayId,
    slug: assignment.slug,
    operationId: ownedBy,
    sourcePod,
  });
  if (!configuredBuilderProcessGateRequired(input)) return undefined;
  const sourceSystemConfigCommit = requireSystemConfigCommit(
    (await deps.flush({
      gatewayId: input.gatewayId,
      slug: assignment.slug,
      operationId: ownedBy,
      pod: sourcePod,
      reason: "migration-final",
    })).systemConfigCommit,
    assignment.slug,
  );
  await holdTargetOpenClaw(deps, {
    gatewayId: input.gatewayId,
    slug: assignment.slug,
    operationId: ownedBy,
    targetPod,
  });
  try {
    await stopSourceOpenClaw(deps, {
      gatewayId: input.gatewayId,
      slug: assignment.slug,
      operationId: ownedBy,
      sourcePod,
      targetPod,
    });
  } catch (error) {
    if (!(error instanceof SurgeOpenClawProcessEndpointMissingError)) throw error;
    deps.log(
      `[surge-handoff] source predates the OpenClaw process gate; copying from the quiesced ` +
      `source and relying on the digest check ` +
      `gateway=${input.gatewayId} source=${sourcePod.name} slug=${assignment.slug}`,
    );
    return sourceSystemConfigCommit;
  }
  if (!heldSourceSlugs.includes(assignment.slug)) heldSourceSlugs.push(assignment.slug);
  return sourceSystemConfigCommit;
}

async function copyAndVerifyAssignment(
  deps: SurgeCustomerHandoffDeps,
  context: AssignmentTransferContext,
  assignment: SurgeAssignment,
  expectedSystemConfigCommit: string | undefined,
): Promise<void> {
  const { input, sourcePod, targetPod, ownedBy } = context;
  const configTransferMode = configTransferModeFor(input);
  await deps.transfer({
    gatewayId: input.gatewayId,
    slug: assignment.slug,
    operationId: ownedBy,
    sourcePod,
    targetPod,
    loadStrategy: input.disposableBuilderGateway === true && sourcePod.terminating
      ? "expedited"
      : "standard",
    configTransferMode,
    ...(expectedSystemConfigCommit ? { expectedSystemConfigCommit } : {}),
  });
  const digestOf = (pod: SurgePod) => deps.readDurableSessionDigest({
    gatewayId: input.gatewayId,
    slug: assignment.slug,
    operationId: ownedBy,
    pod,
    configTransferMode,
  });
  const [sourceDigest, targetDigest] = await Promise.all([digestOf(sourcePod), digestOf(targetPod)]);
  if (!sameDigest(sourceDigest, targetDigest)) {
    throw new Error(
      `durable session digest mismatch for ${assignment.slug} ` +
      `sourcePod=${sourcePod.name} targetPod=${targetPod.name}: ` +
      `source(${describeDigest(sourceDigest)}) target(${describeDigest(targetDigest)})`,
    );
  }
}

// The configured Builder source finalization contract:
// quiesce → final durable flush → reserve target → stop source → copy → verify.
// The flush runs while the source still serves so a flush failure never costs
// availability; the reservation lands before the source stops so the target can
// never self-release into a half-copied state; the copy begins only after the
// source process exits so the digests compare frozen state.
async function transferAssignments(
  deps: SurgeCustomerHandoffDeps,
  context: AssignmentTransferContext & { assignments: readonly SurgeAssignment[] },
): Promise<void> {
  const { input, assignments, targetPod, ownedBy } = context;
  const touchedSlugs: string[] = [];
  try {
    for (const assignment of assignments) {
      await gateServingAssignments(deps, input.gatewayId, [assignment], ownedBy);
      const sourceSystemConfigCommit = await finalizeSourceForAssignment(deps, context, assignment);
      touchedSlugs.push(assignment.slug);
      await copyAndVerifyAssignment(deps, context, assignment, sourceSystemConfigCommit);
    }
  } catch (error) {
    if (configTransferModeFor(input) === "activation-manifest") {
      await discardTargetCustomers(deps, {
        gatewayId: input.gatewayId,
        operationId: ownedBy,
        targetPod,
        slugs: touchedSlugs,
        cause: error,
      });
    } else if (touchedSlugs.length > 0) {
      deps.log(
        `[surge-handoff] preserving configured Builder target state after failed handoff ` +
        `gateway=${input.gatewayId} slugs=${touchedSlugs.join(",")}: ${errorMessage(error)}`,
      );
    }
    throw error;
  }
}

function targetMountedAssignedCustomers(
  assignments: readonly SurgeAssignment[],
  mountedCustomers: readonly string[],
): boolean {
  const assigned = new Set(assignments.map((assignment) => assignment.slug));
  const mounted = new Set(mountedCustomers);
  return assigned.size === mounted.size && [...assigned].every((slug) => mounted.has(slug));
}

type SurgeSourceSelection =
  | { kind: "missing" }
  | { kind: "waiting"; pod: SurgePod }
  | { kind: "ready"; pod: SurgePod };

function selectSource(pods: readonly SurgePod[], target: SurgePod): SurgeSourceSelection {
  const sources = pods.filter((pod) => pod.uid !== target.uid);
  if (sources.length > 1) throw new Error("multiple source pods found");
  const source = sources[0];
  if (!source) return { kind: "missing" };
  return source.ready || source.terminating
    ? { kind: "ready", pod: source }
    : { kind: "waiting", pod: source };
}

async function releaseTargetWithConfirmation(
  deps: SurgeCustomerHandoffDeps,
  input: {
    gatewayId: string;
    operationId: string;
    pod: SurgePod;
    retryHeldConfiguredBuilderTarget?: boolean;
  },
): Promise<void> {
  const releaseOnce = async (): Promise<void> => {
    try {
      await deps.releaseTarget(input);
    } catch (error) {
      const health = await deps.readPodHealth(input.pod, input.gatewayId);
      if (health?.handoffReleased) {
        deps.log(
          `[surge-handoff] confirmed target release after response failure ` +
          `pod=${input.pod.name}`,
        );
        return;
      }
      throw error;
    }
  };
  try {
    await releaseOnce();
  } catch (error) {
    if (!input.retryHeldConfiguredBuilderTarget) throw error;
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    await wait(CONFIGURED_BUILDER_TARGET_RELEASE_RETRY_DELAY_MS);
    const health = await deps.readPodHealth(input.pod, input.gatewayId);
    if (health?.handoffReleased) {
      deps.log(
        `[surge-handoff] confirmed target release after delayed response failure ` +
        `pod=${input.pod.name}`,
      );
      return;
    }
    if (!health || !prelaunchTransferEligible(health)) throw error;
    deps.log(
      `[surge-handoff] retrying configured Builder target release after it returned to hold ` +
      `pod=${input.pod.name}: ${errorMessage(error)}`,
    );
    await releaseOnce();
  }
}

// A held source can never become Ready on its own: only a controller resume
// restarts its OpenClaw. Observing one while waiting therefore means an earlier
// attempt stopped it and died, so the recovery is a health-verified resume now
// and a clean retry on the next pass.
async function recoverHeldWaitingSource(
  deps: SurgeCustomerHandoffDeps,
  input: ReconcileSurgeCustomerHandoffInput,
  context: {
    sourcePod: SurgePod;
    sourceHealth: SurgePodHealth | undefined;
    targetPod: SurgePod;
    ownedBy: string;
    assignments: readonly SurgeAssignment[];
  },
): Promise<void> {
  if (
    !configuredBuilderProcessGateRequired(input) ||
    context.sourceHealth?.prelaunchState !== "held"
  ) {
    return;
  }
  let resumed = false;
  for (const slug of context.assignments.map((assignment) => assignment.slug)) {
    try {
      await resumeSourceOpenClaw(deps, {
        gatewayId: input.gatewayId,
        slug,
        operationId: context.ownedBy,
        sourcePod: context.sourcePod,
        targetPod: context.targetPod,
      });
      resumed = true;
      deps.log(
        `[surge-handoff] resumed a held NotReady source ` +
        `gateway=${input.gatewayId} source=${context.sourcePod.name} slug=${slug}`,
      );
    } catch (error) {
      deps.log(
        `[surge-handoff] held NotReady source resume failed ` +
        `gateway=${input.gatewayId} source=${context.sourcePod.name} slug=${slug}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (resumed) {
    await restoreOwnedAssignments(deps, input.gatewayId, context.assignments, context.ownedBy);
  }
}

// A reserved target whose source pod object is gone waits forever: its
// reservation refuses pod-side self-release and no source can feed a transfer.
// Unreserving converts it back to the no-sibling boot path, which rebuilds from
// durable state.
async function unreserveSourcelessTarget(
  deps: SurgeCustomerHandoffDeps,
  input: ReconcileSurgeCustomerHandoffInput,
  context: {
    targetPod: SurgePod;
    targetHealth: SurgePodHealth;
    ownedBy: string;
    slugs: readonly string[];
  },
): Promise<void> {
  if (
    !configuredBuilderProcessGateRequired(input) ||
    !prelaunchTransferEligible(context.targetHealth) ||
    !deps.unreserveTargetOpenClaw
  ) {
    return;
  }
  for (const slug of context.slugs) {
    try {
      await deps.unreserveTargetOpenClaw({
        gatewayId: input.gatewayId,
        slug,
        operationId: context.ownedBy,
        targetPod: context.targetPod,
      });
      deps.log(
        `[surge-handoff] unreserved a sourceless configured Builder target ` +
        `gateway=${input.gatewayId} target=${context.targetPod.name} slug=${slug}`,
      );
    } catch (error) {
      deps.log(
        `[surge-handoff] sourceless target unreserve failed ` +
        `gateway=${input.gatewayId} target=${context.targetPod.name} slug=${slug}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function releaseSourcelessSharedTarget(
  deps: SurgeCustomerHandoffDeps,
  input: ReconcileSurgeCustomerHandoffInput,
  context: { targetPod: SurgePod; ownedBy: string },
): Promise<void> {
  try {
    await releaseTargetWithConfirmation(deps, {
      gatewayId: input.gatewayId,
      operationId: context.ownedBy,
      pod: context.targetPod,
    });
    deps.log(
      `[surge-handoff] released a sourceless shared target ` +
      `gateway=${input.gatewayId} target=${context.targetPod.name}`,
    );
  } catch (error) {
    deps.log(
      `[surge-handoff] sourceless shared target release failed ` +
      `gateway=${input.gatewayId} target=${context.targetPod.name}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sourceForTransfer(
  deps: SurgeCustomerHandoffDeps,
  input: ReconcileSurgeCustomerHandoffInput,
  source: SurgeSourceSelection,
): SurgePod | null {
  if (source.kind === "missing") {
    deps.log(
      `[surge-handoff] source absent; waiting for pod-side readiness release ` +
      `gateway=${input.gatewayId}`,
    );
    return null;
  }
  if (source.kind === "waiting") {
    deps.log(
      `[surge-handoff] source pod exists but is NotReady; waiting ` +
      `gateway=${input.gatewayId} source=${source.pod.name}`,
    );
    return null;
  }
  return source.pod;
}

async function migrateAssignedState(
  deps: SurgeCustomerHandoffDeps,
  context: {
    input: ReconcileSurgeCustomerHandoffInput;
    assignments: readonly SurgeAssignment[];
    sourcePod: SurgePod;
    targetPod: SurgePod;
    ownedBy: string;
    heldSourceSlugs: string[];
  },
): Promise<void> {
  const { input, assignments, sourcePod, targetPod, ownedBy, heldSourceSlugs } = context;
  const [sourceHealth, targetHealth] = await Promise.all([
    deps.readPodHealth(sourcePod, input.gatewayId),
    deps.readPodHealth(targetPod, input.gatewayId),
  ]);
  if (!sourceHealth) {
    throw new Error(`source health unavailable before handoff on ${input.gatewayId}`);
  }
  if (!targetHealth) {
    throw new Error(`target health unavailable before handoff on ${input.gatewayId}`);
  }
  const assignmentBySlug = new Map(assignments.map((assignment) => [assignment.slug, assignment]));
  const configTransferMode = configTransferModeFor(input);
  const unassignedMount = sourceHealth.mountedCustomers.find((slug) => !assignmentBySlug.has(slug));
  if (unassignedMount) {
    throw new Error(`source mounted customer ${unassignedMount} has no assignment on ${input.gatewayId}`);
  }
  const mounted = new Set(sourceHealth.mountedCustomers);
  for (const assignment of assignments) {
    if (!mounted.has(assignment.slug)) {
      deps.log(
        `[surge-handoff] retaining unmounted assignment without transfer ` +
        `gateway=${input.gatewayId} uid=${assignment.uid} slug=${assignment.slug}`,
      );
    }
  }
  if (targetHealth.mountedCustomers.length > 0) {
    if (configTransferMode === "configured-builder-system-config") {
      const foreignMount = targetHealth.mountedCustomers.find((slug) => !assignmentBySlug.has(slug));
      if (foreignMount) {
        throw new Error(
          `configured Builder target mounted foreign customer ${foreignMount} on ${input.gatewayId}`,
        );
      }
      deps.log(
        `[surge-handoff] preserving configured Builder target mounts before transfer ` +
        `gateway=${input.gatewayId} slugs=${targetHealth.mountedCustomers.join(",")}`,
      );
    } else {
      const staleSlugs = new Set(targetHealth.mountedCustomers);
      const staleAssignments = assignments.filter((assignment) => staleSlugs.has(assignment.slug));
      await gateServingAssignments(deps, input.gatewayId, staleAssignments, ownedBy);
      deps.log(
        `[surge-handoff] cleaning stale target mounts before transfer ` +
        `gateway=${input.gatewayId} slugs=${targetHealth.mountedCustomers.join(",")}`,
      );
      await discardTargetCustomers(deps, {
        gatewayId: input.gatewayId,
        operationId: ownedBy,
        targetPod,
        slugs: targetHealth.mountedCustomers,
      });
      await restoreOwnedAssignments(deps, input.gatewayId, staleAssignments, ownedBy);
    }
  }
  await transferAssignments(deps, {
    input,
    assignments: assignments.filter((assignment) => mounted.has(assignment.slug)),
    sourcePod,
    targetPod,
    ownedBy,
    heldSourceSlugs,
  });
}

async function resumeHeldSources(
  deps: SurgeCustomerHandoffDeps,
  input: {
    gatewayId: string;
    operationId: string;
    sourcePod: SurgePod;
    targetPod: SurgePod;
    slugs: readonly string[];
  },
): Promise<void> {
  for (const slug of [...new Set(input.slugs)].reverse()) {
    await resumeSourceOpenClaw(deps, {
      gatewayId: input.gatewayId,
      slug,
      operationId: input.operationId,
      sourcePod: input.sourcePod,
      targetPod: input.targetPod,
    });
  }
}

// Rollback trusts the observed source, not the bookkeeping: a stop that failed
// before reaching the pod (a source without the process endpoints, a lost
// request) leaves the source running, and resuming it would fail again and
// strand the assignments in quiescing.
async function sourceStillHeld(
  deps: SurgeCustomerHandoffDeps,
  sourcePod: SurgePod,
  gatewayId: string,
): Promise<boolean> {
  const health = await deps.readPodHealth(sourcePod, gatewayId);
  return health === null || health.prelaunchState === "held";
}

async function rollBackConfiguredBuilderHandoff(
  deps: SurgeCustomerHandoffDeps,
  context: {
    input: ReconcileSurgeCustomerHandoffInput;
    assignments: readonly SurgeAssignment[];
    sourcePod: SurgePod;
    targetPod: SurgePod;
    ownedBy: string;
    reservedTargetSlugs: readonly string[];
    heldSourceSlugs: readonly string[];
    targetReleaseAttempted: boolean;
    cause: unknown;
  },
): Promise<void> {
  const {
    input,
    assignments,
    sourcePod,
    targetPod,
    ownedBy,
    reservedTargetSlugs,
    heldSourceSlugs,
    targetReleaseAttempted,
    cause,
  } = context;
  const targetReholdErrors: unknown[] = [];
  for (const slug of [...new Set([...reservedTargetSlugs, ...heldSourceSlugs])]) {
    try {
      await holdTargetOpenClaw(deps, {
        gatewayId: input.gatewayId,
        slug,
        operationId: ownedBy,
        targetPod,
      });
    } catch (error) {
      deps.log(
        `[surge-handoff] rollback target hold failed; the target reservation still blocks its start ` +
        `gateway=${input.gatewayId} target=${targetPod.name} slug=${slug}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
      if (targetReleaseAttempted) targetReholdErrors.push(error);
    }
  }
  if (targetReholdErrors.length > 0) {
    throw new AggregateError(
      [cause, ...targetReholdErrors],
      "configured Builder target could not be re-held after release attempt: " +
        `handoff=${errorMessage(cause)}; rehold=${targetReholdErrors.map(errorMessage).join("; ")}`,
    );
  }
  if (heldSourceSlugs.length > 0 && await sourceStillHeld(deps, sourcePod, input.gatewayId)) {
    try {
      await resumeHeldSources(deps, {
        gatewayId: input.gatewayId,
        operationId: ownedBy,
        sourcePod,
        targetPod,
        slugs: heldSourceSlugs,
      });
    } catch (resumeError) {
      throw new AggregateError(
        [cause, resumeError],
        "configured Builder handoff failed and its source could not be resumed: " +
          `handoff=${errorMessage(cause)}; resume=${errorMessage(resumeError)}`,
      );
    }
  } else if (heldSourceSlugs.length > 0) {
    deps.log(
      `[surge-handoff] source is not held; skipping resume during rollback ` +
      `gateway=${input.gatewayId} source=${sourcePod.name}`,
    );
  }
  await restoreOwnedAssignments(deps, input.gatewayId, assignments, ownedBy);
}

async function migrateAssignmentsAndReleaseTarget(
  deps: SurgeCustomerHandoffDeps,
  context: {
    input: ReconcileSurgeCustomerHandoffInput;
    assignments: SurgeAssignment[];
    sourcePod: SurgePod;
    targetPod: SurgePod;
    ownedBy: string;
    observedPodUids: readonly string[];
  },
): Promise<void> {
  const { input, assignments, sourcePod, targetPod, ownedBy, observedPodUids } = context;
  await restoreAbandonedSurgeAssignments(
    deps,
    input.gatewayId,
    assignments,
    ownedBy,
    {
      observedPodUids,
      reclaimableOwners: new Set([operationId(input.gatewayId, sourcePod.uid)]),
    },
  );
  assertAssignmentsAvailable(assignments, ownedBy);
  const reservedTargetSlugs: string[] = [];
  const heldSourceSlugs: string[] = [];
  let targetReleaseAttempted = false;
  try {
    let freshConfiguredBuilderAssignment: SurgeAssignment | undefined;
    if (input.stateMigration.strategy === "provision-fresh") {
      deps.log(
        `[surge-handoff] skipping state migration; the replacement provisions fresh ` +
        `gateway=${input.gatewayId} — ${input.stateMigration.reason}`,
      );
      if (configuredBuilderProcessGateRequired(input)) {
        if (assignments.length !== 1) {
          throw new Error(
            `configured Builder fresh replacement requires exactly one assignment on ${input.gatewayId}`,
          );
        }
        freshConfiguredBuilderAssignment = assignments[0]!;
      }
    } else {
      await migrateAssignedState(deps, {
        input,
        assignments,
        sourcePod,
        targetPod,
        ownedBy,
        heldSourceSlugs,
      });
    }
    if (freshConfiguredBuilderAssignment) {
      await holdTargetOpenClaw(deps, {
        gatewayId: input.gatewayId,
        slug: freshConfiguredBuilderAssignment.slug,
        operationId: ownedBy,
        targetPod,
      });
      reservedTargetSlugs.push(freshConfiguredBuilderAssignment.slug);
    }
    await gateServingAssignments(deps, input.gatewayId, assignments, ownedBy);
    targetReleaseAttempted = true;
    await releaseTargetWithConfirmation(deps, {
      gatewayId: input.gatewayId,
      operationId: ownedBy,
      pod: targetPod,
      retryHeldConfiguredBuilderTarget: configuredBuilderProcessGateRequired(input),
    });
  } catch (error) {
    if (error instanceof SurgeTargetCleanupError) {
      throw error;
    }
    if (configuredBuilderProcessGateRequired(input)) {
      await rollBackConfiguredBuilderHandoff(deps, {
        input,
        assignments,
        sourcePod,
        targetPod,
        ownedBy,
        reservedTargetSlugs,
        heldSourceSlugs,
        targetReleaseAttempted,
        cause: error,
      });
      throw error;
    }
    if (!targetReleaseAttempted) {
      await restoreOwnedAssignments(deps, input.gatewayId, assignments, ownedBy);
    }
    throw error;
  }
}

async function settleReleasedTarget(
  deps: SurgeCustomerHandoffDeps,
  input: ReconcileSurgeCustomerHandoffInput,
  context: {
    source: SurgeSourceSelection;
    targetHealth: SurgePodHealth;
    ownedBy: string;
    observedPodUids: readonly string[];
  },
): Promise<{ ready: boolean }> {
  const { source, targetHealth, ownedBy, observedPodUids } = context;
  if (source.kind !== "missing") return { ready: false };
  const assignments = await deps.readAssignments(input.gatewayId);
  if (
    input.requiresCustomerMigration &&
    !targetMountedAssignedCustomers(assignments, targetHealth.mountedCustomers)
  ) {
    deps.log(
      `[surge-handoff] target released without its assigned mounted roster ` +
      `gateway=${input.gatewayId} expected=${assignments.map((item) => item.slug).join(",")} ` +
      `observed=${targetHealth.mountedCustomers.join(",")}`,
    );
    return { ready: false };
  }
  await restoreAbandonedSurgeAssignments(
    deps,
    input.gatewayId,
    assignments,
    ownedBy,
    { observedPodUids },
  );
  await restoreOwnedAssignments(deps, input.gatewayId, assignments, ownedBy);
  return { ready: true };
}

async function tendSourcelessTarget(
  deps: SurgeCustomerHandoffDeps,
  input: ReconcileSurgeCustomerHandoffInput,
  context: {
    source: SurgeSourceSelection;
    target: SurgePod;
    targetHealth: SurgePodHealth;
    healthByUid: ReadonlyMap<string, SurgePodHealth>;
    ownedBy: string;
    assignments?: SurgeAssignment[];
  },
): Promise<void> {
  const { source, target, targetHealth, healthByUid, ownedBy, assignments } = context;
  if (source.kind === "missing") {
    if (configuredBuilderProcessGateRequired(input)) {
      const sourceAssignments = assignments ?? await deps.readAssignments(input.gatewayId);
      await unreserveSourcelessTarget(deps, input, {
        targetPod: target,
        targetHealth,
        ownedBy,
        slugs: sourceAssignments.map((assignment) => assignment.slug),
      });
    } else if (input.requiresCustomerMigration) {
      await releaseSourcelessSharedTarget(deps, input, { targetPod: target, ownedBy });
    }
  } else if (source.kind === "waiting" && configuredBuilderProcessGateRequired(input)) {
    const sourceAssignments = assignments ?? await deps.readAssignments(input.gatewayId);
    await recoverHeldWaitingSource(deps, input, {
      sourcePod: source.pod,
      sourceHealth: healthByUid.get(source.pod.uid),
      targetPod: target,
      ownedBy,
      assignments: sourceAssignments,
    });
  }
}

// A held prelaunch target is legitimately NotReady with OpenClaw down, so it
// enters the handoff; every other NotReady target, and a released marker beside
// a normal gate, waits. A Ready target has already been handed off and only
// needs its roster settled.
async function settleOrGateTarget(
  deps: SurgeCustomerHandoffDeps,
  input: ReconcileSurgeCustomerHandoffInput,
  context: {
    target: SurgePod;
    targetHealth: SurgePodHealth;
    source: SurgeSourceSelection;
    ownedBy: string;
    observedPodUids: readonly string[];
  },
): Promise<{ ready: boolean } | null> {
  const { target, targetHealth, source, ownedBy, observedPodUids } = context;
  const heldPrelaunchTarget = configuredBuilderProcessGateRequired(input) &&
    prelaunchTransferEligible(targetHealth);
  if (targetHealth.status !== "ready" && !heldPrelaunchTarget) return { ready: false };
  if (target.ready) {
    return settleReleasedTarget(deps, input, { source, targetHealth, ownedBy, observedPodUids });
  }
  // A released marker beside a held prelaunch gate is rollback residue: the
  // release landed while the controller rolled the handoff back. The gate owns
  // process start, so the retry simply runs the handoff again.
  return targetHealth.handoffReleased && !heldPrelaunchTarget ? { ready: false } : null;
}

function sourceHoldsItsOpenClaw(
  input: ReconcileSurgeCustomerHandoffInput,
  source: SurgeSourceSelection,
  healthByUid: ReadonlyMap<string, SurgePodHealth>,
): boolean {
  return configuredBuilderProcessGateRequired(input) &&
    source.kind !== "missing" &&
    healthByUid.get(source.pod.uid)?.prelaunchState === "held";
}

function hasLegacyFleetSignatureCapability(
  targetHealth: SurgePodHealth,
  sourceHealth: SurgePodHealth | undefined,
): boolean {
  return targetHealth.fleetSignatureCapability === "legacy" ||
    sourceHealth?.fleetSignatureCapability === "legacy";
}

// Handing customers onto pods a queued rollout is about to replace buys nothing.
// Everything that keeps a customer served still runs, because none of it may wait
// on the queue: a gated lease refuses the customer at the edge, and a held source
// cannot restart its own OpenClaw.
async function standDownForSupersedingRelease(
  deps: SurgeCustomerHandoffDeps,
  input: ReconcileSurgeCustomerHandoffInput,
  context: {
    source: SurgeSourceSelection;
    target: SurgePod;
    targetHealth: SurgePodHealth;
    healthByUid: ReadonlyMap<string, SurgePodHealth>;
    ownedBy: string;
    observedPodUids: readonly string[];
  },
): Promise<{ ready: boolean }> {
  const { source, target, targetHealth, healthByUid, ownedBy, observedPodUids } = context;
  deps.log(
    `[surge-handoff] standing down for a queued rollout gateway=${input.gatewayId} ` +
    `serving=${input.desiredImageTag} queued=${input.supersedingImageTag}`,
  );
  const assignments = await deps.readAssignments(input.gatewayId);
  await restoreAbandonedSurgeAssignments(
    deps,
    input.gatewayId,
    assignments,
    null,
    { observedPodUids },
  );
  await tendSourcelessTarget(deps, input, {
    source,
    target,
    targetHealth,
    healthByUid,
    ownedBy,
    assignments,
  });
  // Reopening admits the customer to whichever pod serves them next, so it waits
  // only on a source still holding its OpenClaw down — the resume above owns that
  // case and reopens the lease itself once the process is back.
  if (!sourceHoldsItsOpenClaw(input, source, healthByUid)) {
    await restoreOwnedAssignments(deps, input.gatewayId, assignments, ownedBy);
  }
  return { ready: false };
}

export async function reconcileSurgeCustomerHandoff(
  deps: SurgeCustomerHandoffDeps,
  input: ReconcileSurgeCustomerHandoffInput,
): Promise<{ ready: boolean }> {
  const { pods, observedPodUids } = await deps.listPods(input.gatewayId);
  const healthEntries = await Promise.all(pods.map(async (pod) => [
    pod.uid,
    await deps.readPodHealth(pod, input.gatewayId),
  ] as const));
  const healthByUid = new Map(
    healthEntries.filter((entry): entry is readonly [string, SurgePodHealth] => entry[1] !== null),
  );
  const target = selectTarget(pods, healthByUid, input.desiredImageTag);
  if (!target) {
    const assignments = await deps.readAssignments(input.gatewayId);
    await restoreAbandonedSurgeAssignments(
      deps,
      input.gatewayId,
      assignments,
      null,
      { observedPodUids },
    );
    return { ready: false };
  }
  const targetHealth = healthByUid.get(target.uid);
  if (!targetHealth) return { ready: false };

  const ownedBy = operationId(input.gatewayId, target.uid);
  const source = selectSource(pods, target);
  const sourceHealth = source.kind === "missing" ? undefined : healthByUid.get(source.pod.uid);
  if (hasLegacyFleetSignatureCapability(targetHealth, sourceHealth)) {
    return { ready: false };
  }
  const settled = await settleOrGateTarget(deps, input, {
    target,
    targetHealth,
    source,
    ownedBy,
    observedPodUids,
  });
  // A settled target is a handoff that already finished — the release it proves
  // still marks live, because withholding that would gate the Dashboard behind a
  // queue this gateway is not waiting on.
  if (settled?.ready) return settled;
  if (input.supersedingImageTag) {
    return standDownForSupersedingRelease(deps, input, {
      source,
      target,
      targetHealth,
      healthByUid,
      ownedBy,
      observedPodUids,
    });
  }
  if (settled) return settled;

  let assignments: SurgeAssignment[] | null = null;
  if (input.requiresCustomerMigration && input.ownerlessOperatorPrewarm === true) {
    assignments = await deps.readAssignments(input.gatewayId);
    if (assignments.length === 0) {
      await releaseTargetWithConfirmation(deps, {
        gatewayId: input.gatewayId,
        operationId: ownedBy,
        pod: target,
      });
      return { ready: false };
    }
  }

  const sourcePod = sourceForTransfer(deps, input, source);
  if (!sourcePod) {
    await tendSourcelessTarget(deps, input, {
      source,
      target,
      targetHealth,
      healthByUid,
      ownedBy,
      ...(assignments ? { assignments } : {}),
    });
    return { ready: false };
  }

  assignments ??= await deps.readAssignments(input.gatewayId);
  await migrateAssignmentsAndReleaseTarget(deps, {
    input,
    assignments,
    sourcePod,
    targetPod: target,
    ownedBy,
    observedPodUids,
  });
  return { ready: false };
}
