import type { AssignmentState } from "@octogee/shared/types/gateway-releases";
import type { OperationStatus } from "@octogee/shared/types/glm";
import { gatewayHeartbeatMatchesImageTag } from "@octogee/shared/types/image-tag";
import type { RollStateMigrationDecision } from "./roll-state-migration.js";

export interface SurgePod {
  uid: string;
  name: string;
  podIP: string;
  ready: boolean;
}

export interface SurgePodSnapshot {
  pods: readonly SurgePod[];
  observedPodUids: readonly string[];
}

export interface SurgePodHealth {
  status: "booting" | "ready";
  version: string;
  handoffReleased: boolean;
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

export interface SurgeCustomerHandoffDeps {
  listPods: (gatewayId: string) => Promise<SurgePodSnapshot>;
  readPodHealth: (pod: SurgePod) => Promise<SurgePodHealth | null>;
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
  transfer: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    sourcePod: SurgePod;
    targetPod: SurgePod;
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
  }) => Promise<SessionDigest>;
  releaseTarget: (input: {
    gatewayId: string;
    operationId: string;
    pod: SurgePod;
  }) => Promise<void>;
  readOwnerOperation: (operationId: string) => Promise<{ status: OperationStatus } | null>;
  log: (message: string) => void;
}

export interface ReconcileSurgeCustomerHandoffInput {
  gatewayId: string;
  desiredImageTag: string;
  requiresCustomerMigration: boolean;
  ownerlessOperatorPrewarm?: boolean;
  stateMigration: RollStateMigrationDecision;
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
  const desired = pods.filter((pod) => gatewayHeartbeatMatchesImageTag(
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

async function transferAssignments(
  deps: SurgeCustomerHandoffDeps,
  context: {
    input: ReconcileSurgeCustomerHandoffInput;
    assignments: readonly SurgeAssignment[];
    sourcePod: SurgePod;
    targetPod: SurgePod;
    ownedBy: string;
  },
): Promise<void> {
  const {
    input,
    assignments,
    sourcePod,
    targetPod,
    ownedBy,
  } = context;
  const touchedSlugs: string[] = [];
  try {
    for (const assignment of assignments) {
      await gateServingAssignments(
        deps,
        input.gatewayId,
        [assignment],
        ownedBy,
      );
      await deps.quiesce({
        gatewayId: input.gatewayId,
        slug: assignment.slug,
        operationId: ownedBy,
        sourcePod,
      });
      touchedSlugs.push(assignment.slug);
      await deps.transfer({
        gatewayId: input.gatewayId,
        slug: assignment.slug,
        operationId: ownedBy,
        sourcePod,
        targetPod,
      });
      const [sourceDigest, targetDigest] = await Promise.all([
        deps.readDurableSessionDigest({
          gatewayId: input.gatewayId,
          slug: assignment.slug,
          operationId: ownedBy,
          pod: sourcePod,
        }),
        deps.readDurableSessionDigest({
          gatewayId: input.gatewayId,
          slug: assignment.slug,
          operationId: ownedBy,
          pod: targetPod,
        }),
      ]);
      if (!sameDigest(sourceDigest, targetDigest)) {
        throw new Error(`durable session digest mismatch for ${assignment.slug}`);
      }
    }
  } catch (error) {
    await discardTargetCustomers(deps, {
      gatewayId: input.gatewayId,
      operationId: ownedBy,
      targetPod,
      slugs: touchedSlugs,
      cause: error,
    });
    throw error;
  }
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
  return source.ready ? { kind: "ready", pod: source } : { kind: "waiting", pod: source };
}

async function releaseTargetWithConfirmation(
  deps: SurgeCustomerHandoffDeps,
  input: { gatewayId: string; operationId: string; pod: SurgePod },
): Promise<void> {
  try {
    await deps.releaseTarget(input);
  } catch (error) {
    const health = await deps.readPodHealth(input.pod);
    if (health?.handoffReleased) {
      deps.log(
        `[surge-handoff] confirmed target release after response failure ` +
        `pod=${input.pod.name}`,
      );
      return;
    }
    throw error;
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
  },
): Promise<void> {
  const { input, assignments, sourcePod, targetPod, ownedBy } = context;
  const [sourceHealth, targetHealth] = await Promise.all([
    deps.readPodHealth(sourcePod),
    deps.readPodHealth(targetPod),
  ]);
  if (!sourceHealth) {
    throw new Error(`source health unavailable before handoff on ${input.gatewayId}`);
  }
  if (!targetHealth) {
    throw new Error(`target health unavailable before handoff on ${input.gatewayId}`);
  }
  const assignmentBySlug = new Map(assignments.map((assignment) => [assignment.slug, assignment]));
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
  await transferAssignments(deps, {
    input,
    assignments: assignments.filter((assignment) => mounted.has(assignment.slug)),
    sourcePod,
    targetPod,
    ownedBy,
  });
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
  try {
    if (input.stateMigration.strategy === "provision-fresh") {
      deps.log(
        `[surge-handoff] skipping state migration; the replacement provisions fresh ` +
        `gateway=${input.gatewayId} — ${input.stateMigration.reason}`,
      );
    } else {
      await migrateAssignedState(deps, { input, assignments, sourcePod, targetPod, ownedBy });
    }
    await gateServingAssignments(deps, input.gatewayId, assignments, ownedBy);
  } catch (error) {
    if (error instanceof SurgeTargetCleanupError) throw error;
    await restoreOwnedAssignments(deps, input.gatewayId, assignments, ownedBy);
    throw error;
  }
  await releaseTargetWithConfirmation(deps, {
    gatewayId: input.gatewayId,
    operationId: ownedBy,
    pod: targetPod,
  });
}

export async function reconcileSurgeCustomerHandoff(
  deps: SurgeCustomerHandoffDeps,
  input: ReconcileSurgeCustomerHandoffInput,
): Promise<{ ready: boolean }> {
  const { pods, observedPodUids } = await deps.listPods(input.gatewayId);
  const healthEntries = await Promise.all(pods.map(async (pod) => [
    pod.uid,
    await deps.readPodHealth(pod),
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
  if (targetHealth.status !== "ready") return { ready: false };
  if (target.ready) {
    if (source.kind !== "missing") return { ready: false };
    const assignments = await deps.readAssignments(input.gatewayId);
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
  if (targetHealth.handoffReleased) {
    return { ready: false };
  }

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
  if (!sourcePod) return { ready: false };

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
