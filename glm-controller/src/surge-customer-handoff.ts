import type { AssignmentState } from "@octogee/shared/types/gateway-releases";

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
  log: (message: string) => void;
}

export interface ReconcileSurgeCustomerHandoffInput {
  gatewayId: string;
  desiredVersion: string;
  requiresCustomerMigration: boolean;
}

function operationId(gatewayId: string, targetPodUid: string): string {
  return `surge-${gatewayId}-${targetPodUid}`;
}

const SURGE_OPERATION_ID_RE =
  /^surge-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

function isSurgeOwnerForGateway(owner: string, gatewayId: string): boolean {
  return SURGE_OPERATION_ID_RE.exec(owner)?.[1] === gatewayId;
}

function selectTarget(
  pods: readonly SurgePod[],
  healthByUid: ReadonlyMap<string, SurgePodHealth>,
  desiredVersion: string,
): SurgePod | null {
  const desired = pods.filter((pod) => healthByUid.get(pod.uid)?.version === desiredVersion);
  const blocked = desired.filter((pod) => !pod.ready);
  if (blocked.length === 1) return blocked[0];
  if (blocked.length > 1) {
    throw new Error(`multiple blocked replacement pods report desired build ${desiredVersion}`);
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

async function restoreOwnedAssignments(
  deps: SurgeCustomerHandoffDeps,
  gatewayId: string,
  assignments: readonly SurgeAssignment[],
  ownedBy: string,
): Promise<void> {
  for (const assignment of assignments) {
    if (assignment.state === "quiescing" && assignment.updatedByOperationId === ownedBy) {
      await setAssignmentState(deps, gatewayId, assignment, "serving", ownedBy);
    }
  }
}

async function restoreAbandonedSurgeAssignments(
  deps: SurgeCustomerHandoffDeps,
  gatewayId: string,
  assignments: readonly SurgeAssignment[],
  ownedBy: string | null,
  observedPodUids: readonly string[],
): Promise<void> {
  const liveSurgeOwners = new Set(observedPodUids.map((uid) => operationId(gatewayId, uid)));
  for (const assignment of assignments) {
    const priorOwner = assignment.updatedByOperationId;
    if (
      assignment.state !== "quiescing" ||
      priorOwner === null ||
      priorOwner === ownedBy ||
      !isSurgeOwnerForGateway(priorOwner, gatewayId) ||
      liveSurgeOwners.has(priorOwner)
    ) {
      continue;
    }
    deps.log(
      `[surge-handoff] restoring abandoned assignment ` +
      `gateway=${gatewayId} uid=${assignment.uid} owner=${priorOwner}`,
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
  const { input, assignments, sourcePod, targetPod, ownedBy } = context;
  for (const assignment of assignments) {
    await deps.quiesce({
      gatewayId: input.gatewayId,
      slug: assignment.slug,
      operationId: ownedBy,
      sourcePod,
    });
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
  const target = selectTarget(pods, healthByUid, input.desiredVersion);
  if (!target) {
    const assignments = await deps.readAssignments(input.gatewayId);
    await restoreAbandonedSurgeAssignments(
      deps,
      input.gatewayId,
      assignments,
      null,
      observedPodUids,
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
      observedPodUids,
    );
    await restoreOwnedAssignments(deps, input.gatewayId, assignments, ownedBy);
    return { ready: true };
  }
  if (targetHealth.handoffReleased) {
    return { ready: false };
  }

  const sourcePod = sourceForTransfer(deps, input, source);
  if (!sourcePod) return { ready: false };

  const assignments = await deps.readAssignments(input.gatewayId);
  await restoreAbandonedSurgeAssignments(
    deps,
    input.gatewayId,
    assignments,
    ownedBy,
    observedPodUids,
  );
  assertAssignmentsAvailable(assignments, ownedBy);
  try {
    for (const assignment of assignments) {
      if (assignment.state === "serving") {
        await setAssignmentState(deps, input.gatewayId, assignment, "quiescing", ownedBy);
        assignment.state = "quiescing";
        assignment.updatedByOperationId = ownedBy;
      }
    }
    await transferAssignments(deps, {
      input,
      assignments,
      sourcePod,
      targetPod: target,
      ownedBy,
    });
  } catch (error) {
    try {
      for (const assignment of assignments) {
        await deps.discardTargetCustomer({
          gatewayId: input.gatewayId,
          slug: assignment.slug,
          operationId: ownedBy,
          targetPod: target,
        });
      }
    } catch (cleanupError) {
      throw new Error(
        `surge target cleanup failed; admission remains closed: ` +
        `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: error },
      );
    }
    await restoreOwnedAssignments(deps, input.gatewayId, assignments, ownedBy);
    throw error;
  }
  await releaseTargetWithConfirmation(deps, {
    gatewayId: input.gatewayId,
    operationId: ownedBy,
    pod: target,
  });
  return { ready: false };
}
