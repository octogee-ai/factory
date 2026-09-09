import type { Firestore } from "firebase-admin/firestore";

import {
  GATEWAY_UNREACHABLE_AFTER_MS,
  GATEWAYS_COLLECTION,
} from "@octogee/shared/types/fleet-controller";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  isOperatorManaged,
} from "@octogee/shared/types/glm";
import {
  GATEWAY_RELEASES_SUBCOLLECTION,
  hasFreshReadyKubernetesObservation,
  isGatewayRuntimeDoc,
  isReleasePayload,
  projectGatewayDesiredRootForGateway,
  releasePayloadHash,
  type GatewayRuntimeDoc,
  type ReleaseDoc,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import type { SharedGatewayPoolConfig } from "@octogee/shared/types/shared-gateway-pool";
import { gatewayArtifactFromReleasePayload } from "./gateway-live-release.js";
import { readSharedGatewayPoolConfig } from "./shared-gateway-pool-read.js";
import {
  FleetMutationIdempotencyError,
  runNormalFleetMutation,
  type NormalFleetMutationDb,
} from "./normal-fleet-mutation.js";

const ACTOR = "glm-controller-placement-policy";

export interface SupersedeRollingSharedGatewayRollInput {
  sourceGatewayId: string;
  targetGatewayId: string;
  expectedLiveRelease: number;
  expectedDesiredRelease: number;
  targetHeartbeatMaxAgeMs?: number;
}

export type SupersedeRollingSharedGatewayRollResult =
  | { kind: "scheduled"; release: number; operationId: string }
  | { kind: "already-scheduled"; release: number; operationId: string }
  | { kind: "not-eligible" };

export interface SharedGatewayRollRecoveryDeps {
  db: Firestore;
  now: () => number;
}

function recoveryOperationId(input: SupersedeRollingSharedGatewayRollInput): string {
  return `recover-shared-roll-${input.sourceGatewayId}-to-${input.targetGatewayId}-r${input.expectedDesiredRelease}-to-r${input.expectedLiveRelease}`;
}

function recoveryIdempotencyKey(input: SupersedeRollingSharedGatewayRollInput): string {
  return [
    "shared-peer-roll-recovery",
    input.sourceGatewayId,
    input.targetGatewayId,
    input.expectedDesiredRelease,
    input.expectedLiveRelease,
  ].join(":");
}

function isPositiveRelease(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function snapshotData(snapshot: { exists: boolean; data(): unknown }): unknown {
  if (!snapshot.exists) return undefined;
  return snapshot.data();
}

function gatewayRootFromSnapshot(
  snapshot: { exists: boolean; data(): unknown },
  gatewayId: string,
) {
  return projectGatewayDesiredRootForGateway(snapshotData(snapshot), gatewayId);
}

function gatewayRuntimeFromSnapshot(
  snapshot: { exists: boolean; data(): unknown },
): GatewayRuntimeDoc | null {
  const value = snapshotData(snapshot);
  return isGatewayRuntimeDoc(value) ? value : null;
}

function runtimeIsServingLiveRelease(
  runtime: GatewayRuntimeDoc | null,
  input: SupersedeRollingSharedGatewayRollInput,
  now: number,
): boolean {
  if (!runtime) return false;
  return [
    runtime.gatewayId === input.targetGatewayId,
    runtime.release === input.expectedLiveRelease,
    runtime.lifecycle === "serving",
    runtime.heartbeat.status === "ready",
    hasFreshReadyKubernetesObservation(
      runtime,
      now,
      input.targetHeartbeatMaxAgeMs ?? GATEWAY_UNREACHABLE_AFTER_MS,
    ),
  ].every(Boolean);
}

function sourceHasFreshMissingKubernetesObservation(
  runtime: GatewayRuntimeDoc | null,
  input: SupersedeRollingSharedGatewayRollInput,
  now: number,
): boolean {
  const observedAt = runtime?.kubernetes?.observedAt;
  const maxAge = input.targetHeartbeatMaxAgeMs ?? GATEWAY_UNREACHABLE_AFTER_MS;
  return runtime?.gatewayId === input.sourceGatewayId &&
    runtime.kubernetes?.status === "missing" &&
    typeof observedAt === "number" &&
    now >= observedAt &&
    now - observedAt <= maxAge;
}

function targetRosterIsServing(
  assignments: ReadonlyArray<{ data(): Record<string, unknown> }>,
  runtime: GatewayRuntimeDoc | null,
): boolean {
  const mounted = new Set(runtime?.heartbeat.mountedCustomers ?? []);
  return assignments.every((assignment) => {
    const data = assignment.data();
    return data.state === "serving" &&
      typeof data.slug === "string" &&
      mounted.has(data.slug);
  });
}

function activeMigrationTargetsGateway(
  operations: ReadonlyArray<{ data(): Record<string, unknown> }>,
  gatewayId: string,
): boolean {
  return operations.some((operation) => {
    const data = operation.data();
    if (data.kind !== "migrate-customer") return false;
    const input = data.input;
    const migration = data.customerMigrationV2;
    const fields = [
      input && typeof input === "object" && !Array.isArray(input)
        ? input as Record<string, unknown>
        : null,
      migration && typeof migration === "object" && !Array.isArray(migration)
        ? migration as Record<string, unknown>
        : null,
    ];
    return fields.some((field) =>
      field?.fromGatewayId === gatewayId ||
      field?.toGatewayId === gatewayId ||
      field?.sourceGatewayId === gatewayId ||
      field?.targetGatewayId === gatewayId,
    );
  });
}

function matchingRecoveryOperation(
  value: Record<string, unknown> | undefined,
  input: SupersedeRollingSharedGatewayRollInput,
  release: number,
): boolean {
  const operationInput = value?.input;
  if (!operationInput || typeof operationInput !== "object" || Array.isArray(operationInput)) {
    return false;
  }
  const record = operationInput as Record<string, unknown>;
  const recovery = record.sharedPeerRollRecovery;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) return false;
  const detail = recovery as Record<string, unknown>;
  return [
    value?.kind === "rollout",
    record.gatewayId === input.targetGatewayId,
    record.targetRelease === release,
    detail.sourceGatewayId === input.sourceGatewayId,
    detail.targetGatewayId === input.targetGatewayId,
    detail.supersededRelease === input.expectedDesiredRelease,
    detail.sourceRelease === input.expectedLiveRelease,
  ].every(Boolean);
}

interface RecoveryRollState {
  target: ReturnType<typeof projectGatewayDesiredRootForGateway>;
  source: ReturnType<typeof projectGatewayDesiredRootForGateway>;
  pool: SharedGatewayPoolConfig | null;
  runtime: GatewayRuntimeDoc | null;
  sourceRuntime: GatewayRuntimeDoc | null;
  assignments: ReadonlyArray<{ data(): Record<string, unknown> }>;
  operations: ReadonlyArray<{ data(): Record<string, unknown> }>;
  now: number;
}

function recoveryRollIsEligible(
  state: RecoveryRollState,
  input: SupersedeRollingSharedGatewayRollInput,
): boolean {
  const { target, source, pool } = state;
  if (!target || !source || !pool) return false;
  return [
    pool.sharedGatewayIds.includes(input.sourceGatewayId),
    pool.sharedGatewayIds.includes(input.targetGatewayId),
    source.gatewayClass === "shared",
    target.gatewayClass === "shared",
    source.desiredStatus === "running",
    target.desiredStatus === "running",
    !isOperatorManaged(source.managedBy),
    !isOperatorManaged(target.managedBy),
    target.liveRelease === input.expectedLiveRelease,
    target.desiredRelease === input.expectedDesiredRelease,
    target.latestRelease === input.expectedDesiredRelease,
    runtimeIsServingLiveRelease(state.runtime, input, state.now),
    sourceHasFreshMissingKubernetesObservation(state.sourceRuntime, input, state.now),
    targetRosterIsServing(state.assignments, state.runtime),
    !activeMigrationTargetsGateway(state.operations, input.targetGatewayId),
  ].every(Boolean);
}

function validReleasePayloadFromSnapshot(
  snapshot: { exists: boolean; data(): unknown },
): ReleasePayload | null {
  const sourceRelease = snapshotData(snapshot) as ReleaseDoc | undefined;
  const payload = sourceRelease?.payload;
  if (!payload || !isReleasePayload(payload)) return null;
  return sourceRelease.payloadHash === releasePayloadHash(payload) ? payload : null;
}

async function appendRecoveryRollback(
  deps: SharedGatewayRollRecoveryDeps,
  input: SupersedeRollingSharedGatewayRollInput,
): Promise<SupersedeRollingSharedGatewayRollResult> {
  const { db } = deps;
  const targetRef = db.collection(GATEWAYS_COLLECTION).doc(input.targetGatewayId);
  const sourceRef = db.collection(GATEWAYS_COLLECTION).doc(input.sourceGatewayId);
  const runtimeRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(input.targetGatewayId);
  const sourceRuntimeRef = db.collection(GLM_GATEWAYS_COLLECTION).doc(input.sourceGatewayId);
  const targetAssignments = targetRef.collection("assignments");
  const activeOperations = db
    .collection(GLM_OPERATIONS_COLLECTION)
    .where("status", "in", ["pending", "running"]);
  const operationId = recoveryOperationId(input);
  const operationRef = db.collection(GLM_OPERATIONS_COLLECTION).doc(operationId);
  return db.runTransaction(async (txn) => {
    const [
      targetSnapshot,
      sourceSnapshot,
      runtimeSnapshot,
      sourceRuntimeSnapshot,
      pool,
      operationSnapshot,
      assignmentsSnapshot,
      operationsSnapshot,
    ] = await Promise.all([
      txn.get(targetRef),
      txn.get(sourceRef),
      txn.get(runtimeRef),
      txn.get(sourceRuntimeRef),
      readSharedGatewayPoolConfig(db, txn),
      txn.get(operationRef),
      txn.get(targetAssignments),
      txn.get(activeOperations),
    ]);
    const state: RecoveryRollState = {
      target: gatewayRootFromSnapshot(targetSnapshot, input.targetGatewayId),
      source: gatewayRootFromSnapshot(sourceSnapshot, input.sourceGatewayId),
      pool,
      runtime: gatewayRuntimeFromSnapshot(runtimeSnapshot),
      sourceRuntime: gatewayRuntimeFromSnapshot(sourceRuntimeSnapshot),
      assignments: assignmentsSnapshot.docs,
      operations: operationsSnapshot.docs,
      now: deps.now(),
    };
    if (!state.target || !recoveryRollIsEligible(state, input)) {
      return { kind: "not-eligible" };
    }
    const release = state.target.latestRelease + 1;
    if (!isPositiveRelease(release)) {
      throw new Error(`shared peer recovery release is invalid for ${input.targetGatewayId}`);
    }
    if (operationSnapshot.exists) {
      return matchingRecoveryOperation(operationSnapshot.data(), input, release)
        ? { kind: "already-scheduled", release, operationId }
        : { kind: "not-eligible" };
    }
    const [sourceReleaseSnapshot, replacementReleaseSnapshot] = await Promise.all([
      txn.get(targetRef.collection(GATEWAY_RELEASES_SUBCOLLECTION).doc(String(input.expectedLiveRelease))),
      txn.get(targetRef.collection(GATEWAY_RELEASES_SUBCOLLECTION).doc(String(release))),
    ]);
    if (replacementReleaseSnapshot.exists) {
      throw new Error(
        `shared peer recovery release ${input.targetGatewayId}/r${release} already exists`,
      );
    }
    const payload = validReleasePayloadFromSnapshot(sourceReleaseSnapshot);
    if (!payload) {
      throw new Error(
        `shared peer recovery source release ${input.targetGatewayId}/r${input.expectedLiveRelease} is invalid`,
      );
    }
    const artifact = gatewayArtifactFromReleasePayload(payload);
    const releaseDocument: ReleaseDoc = {
      gatewayId: input.targetGatewayId,
      release,
      createdAt: state.now,
      createdBy: ACTOR,
      sourceRelease: input.expectedLiveRelease,
      note: `shared peer recovery from ${input.sourceGatewayId}`,
      payloadHash: releasePayloadHash(payload),
      payload: payload as ReleasePayload,
    };
    txn.create(
      targetRef.collection(GATEWAY_RELEASES_SUBCOLLECTION).doc(String(release)),
      releaseDocument as unknown as Record<string, unknown>,
    );
    txn.update(targetRef, {
      latestRelease: release,
      updatedAt: state.now,
      updatedBy: ACTOR,
    });
    txn.create(operationRef, {
      kind: "rollout",
      status: "pending",
      origin: "automatic",
      createdBy: ACTOR,
      createdAt: state.now,
      startedAt: null,
      completedAt: null,
      input: {
        gatewayId: input.targetGatewayId,
        targetRelease: release,
        imageTag: artifact.imageTag,
        imageRepository: artifact.imageRepository,
        sharedPeerRollRecovery: {
          sourceGatewayId: input.sourceGatewayId,
          targetGatewayId: input.targetGatewayId,
          supersededRelease: input.expectedDesiredRelease,
          sourceRelease: input.expectedLiveRelease,
        },
      },
      steps: [],
      gatewayId: input.targetGatewayId,
    });
    return { kind: "scheduled", release, operationId };
  });
}

export async function supersedeRollingSharedGatewayRoll(
  deps: SharedGatewayRollRecoveryDeps,
  input: SupersedeRollingSharedGatewayRollInput,
): Promise<SupersedeRollingSharedGatewayRollResult> {
  try {
    return await runNormalFleetMutation(deps.db as unknown as NormalFleetMutationDb, {
      actor: ACTOR,
      forced: false,
      what: "supersede rolling shared gateway",
      why: "shared gateway recovery",
      target: { gatewayId: input.targetGatewayId },
      preActionStatus: {
        sourceGatewayId: input.sourceGatewayId,
        expectedLiveRelease: input.expectedLiveRelease,
        expectedDesiredRelease: input.expectedDesiredRelease,
      },
      mutation: {
        kind: "supersede-rolling-shared-gateway",
        sourceGatewayId: input.sourceGatewayId,
        targetGatewayId: input.targetGatewayId,
        expectedLiveRelease: input.expectedLiveRelease,
        expectedDesiredRelease: input.expectedDesiredRelease,
      },
      idempotencyKey: recoveryIdempotencyKey(input),
      now: deps.now,
      action: () => appendRecoveryRollback(deps, input),
      classifyResult: (result) => result.kind === "scheduled"
        ? {
            outcome: "completed",
            releaseRollout: {
              releaseId: `${input.targetGatewayId}/${result.release}`,
              rolloutOperationId: result.operationId,
            },
          }
        : {
            outcome: "partial",
            partialOutcome: {
              summary: "shared peer recovery no longer eligible",
              details: { targetGatewayId: input.targetGatewayId },
            },
          },
    });
  } catch (error) {
    if (!(error instanceof FleetMutationIdempotencyError)) throw error;
    const audit = await deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(error.auditId).get();
    const data = audit.exists ? audit.data() : undefined;
    const linkage = data?.releaseRollout;
    if (
      data?.status === "completed" &&
      linkage &&
      typeof linkage === "object" &&
      typeof (linkage as Record<string, unknown>).rolloutOperationId === "string" &&
      typeof (linkage as Record<string, unknown>).releaseId === "string"
    ) {
      const releaseId = (linkage as Record<string, unknown>).releaseId as string;
      const release = Number(releaseId.split("/").at(-1));
      if (Number.isSafeInteger(release) && release >= 1) {
        return {
          kind: "already-scheduled",
          release,
          operationId: (linkage as Record<string, unknown>).rolloutOperationId as string,
        };
      }
    }
    throw error;
  }
}
