import type { DocumentData, DocumentReference, Firestore, Transaction } from "firebase-admin/firestore";
import { isDeepStrictEqual } from "node:util";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";
import {
  GATEWAY_RELEASES_SUBCOLLECTION,
  isGatewayDesiredDoc,
  isReleasePayload,
  releasePayloadHash,
  type GatewayDoc,
  type ReleaseDoc,
  type ReleasePayload,
} from "@octogee/shared/types/gateway-releases";
import {
  projectGatewayMutableConfigForGateway,
  type GatewayMutableConfig,
} from "@octogee/shared/types/gateway-mutable-config";
import { gatewayArtifactFromReleasePayload, type GatewayArtifact } from "./gateway-live-release.js";
import { assertGatewayRuntimeMutationUnfenced, GatewayRetirementConflictError } from "./gateway-retirement-claim.js";

export type DurableGatewayRoot = GatewayDoc & GatewayMutableConfig;

export function asDurableGatewayRoot(
  data: unknown,
  gatewayId: string,
): DurableGatewayRoot | null {
  if (!isGatewayDesiredDoc(data) || data.gatewayId !== gatewayId) return null;
  return projectGatewayMutableConfigForGateway(data, gatewayId) as DurableGatewayRoot | null;
}

export class StaleGatewayReleaseError extends Error {
  constructor(
    readonly gatewayId: string,
    readonly expectedRelease: number,
    readonly actualRelease: number,
  ) {
    super(
      `gateway ${gatewayId} changed while this release was being cut ` +
        `(expected ${expectedRelease}, found ${actualRelease})`,
    );
  }
}

export class InvalidGatewayRootError extends Error {
  constructor(readonly gatewayId: string) {
    super(`gateway ${gatewayId} durable root is invalid`);
  }
}

export class GatewayOwnerChangeError extends Error {
  constructor(readonly gatewayId: string, readonly field: "ownerUid" | "builderSlug") {
    super(`gateway ${gatewayId} ${field} is already bound; a release cannot change it`);
  }
}

function assertOwnerUnchanged(current: DurableGatewayRoot, caller: DurableGatewayRoot): void {
  for (const field of ["ownerUid", "builderSlug"] as const) {
    if (current[field] !== null && caller[field] !== current[field]) {
      throw new GatewayOwnerChangeError(current.gatewayId, field);
    }
  }
}

export interface AppendGatewayReleaseArgs {
  gateway: DurableGatewayRoot;
  artifact: GatewayArtifact;
  payload?: ReleasePayload;
  createdBy: string;
  now: number;
  sourceRelease: number | null;
  note: string | null;
  origin?: "automatic" | "operator";
}

export function rolloutOperationInput(
  gatewayId: string,
  targetRelease: number,
  artifact: GatewayArtifact,
): Record<string, unknown> {
  return {
    gatewayId,
    targetRelease,
    imageTag: artifact.imageTag,
    imageRepository: artifact.imageRepository,
  };
}

async function currentRootForAppend(
  transaction: Transaction,
  gatewayRef: DocumentReference,
  args: AppendGatewayReleaseArgs,
): Promise<GatewayDoc> {
  const snapshot = await transaction.get(gatewayRef);
  const current = asDurableGatewayRoot(snapshot.data(), args.gateway.gatewayId);
  if (!current) throw new InvalidGatewayRootError(args.gateway.gatewayId);
  assertOwnerUnchanged(current, args.gateway);
  if (current.desiredStatus === "retired" || current.retirementClaim != null) {
    throw new GatewayRetirementConflictError(
      `gateway ${args.gateway.gatewayId} has a current retirement claim`,
    );
  }
  if (current.latestRelease !== args.gateway.latestRelease) {
    throw new StaleGatewayReleaseError(
      args.gateway.gatewayId,
      args.gateway.latestRelease,
      current.latestRelease,
    );
  }
  return current;
}

async function assertReleaseIsNew(
  transaction: Transaction,
  gatewayRef: DocumentReference,
  gatewayId: string,
  release: number,
): Promise<void> {
  const releaseRef = gatewayRef.collection(GATEWAY_RELEASES_SUBCOLLECTION).doc(String(release));
  if (await transaction.get(releaseRef).then((snapshot) => snapshot.exists)) {
    throw new Error(
      `appendGatewayRelease: gateways/${gatewayId}/releases/${release} already exists — refusing to overwrite immutable history`,
    );
  }
}

function releasePayloadFor(args: AppendGatewayReleaseArgs): ReleasePayload {
  const payload = args.payload ?? ({ ...args.artifact } as ReleasePayload);
  if (!isReleasePayload(payload)) {
    throw new Error("appendGatewayRelease requires a valid immutable release payload");
  }
  return payload;
}

export async function appendGatewayRelease(
  db: Firestore,
  args: AppendGatewayReleaseArgs,
): Promise<{ release: number; operationId: string | null }> {
  const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(args.gateway.gatewayId);
  const operationRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
  return db.runTransaction(async (transaction) => {
    const current = await currentRootForAppend(transaction, gatewayRef, args);
    await assertGatewayRuntimeMutationUnfenced(db, transaction, args.gateway.gatewayId);
    const release = current.latestRelease + 1;
    await assertReleaseIsNew(transaction, gatewayRef, args.gateway.gatewayId, release);
    const payload = releasePayloadFor(args);
    writeGatewayRelease(transaction, gatewayRef, operationRef, args, { release, payload });
    return { release, operationId: operationRef.id };
  });
}

function writeGatewayRelease(transaction: Transaction, gatewayRef: DocumentReference, operationRef: DocumentReference,
  args: AppendGatewayReleaseArgs, record: { release: number; payload: ReleasePayload; activate?: boolean }): void {
  const { release, payload, activate = false } = record;
  const releaseDoc: ReleaseDoc = {
    gatewayId: args.gateway.gatewayId,
    release,
    createdAt: args.now,
    createdBy: args.createdBy,
    sourceRelease: args.sourceRelease,
    note: args.note,
    payloadHash: releasePayloadHash(payload),
    payload,
  };
  transaction.set(gatewayRef.collection(GATEWAY_RELEASES_SUBCOLLECTION).doc(String(release)), releaseDoc as unknown as Record<string, unknown>);
  transaction.update(gatewayRef, {
    latestRelease: release,
    ...(activate ? { desiredRelease: release } : {}),
    updatedAt: args.now,
    updatedBy: args.createdBy,
  });
  transaction.set(operationRef, {
    kind: "rollout",
    status: "pending",
    createdBy: args.createdBy,
    ...(args.origin ? { origin: args.origin } : {}),
    createdAt: args.now,
    startedAt: null,
    completedAt: null,
    input: rolloutOperationInput(args.gateway.gatewayId, release, gatewayArtifactFromReleasePayload(payload)),
    steps: [],
    gatewayId: args.gateway.gatewayId,
  });
}

interface RecoveredGatewayReleaseInput {
  gatewayId: string; operationId: string; claimedStartedAt: number | null; payload: ReleasePayload; now: number;
}
function recoveredSharedRoot(current: DurableGatewayRoot | null): current is DurableGatewayRoot {
  return current !== null && current.gatewayClass === "shared" && current.ownerUid === null && current.builderSlug === null &&
    ["running", "draining"].includes(current.desiredStatus) && current.retirementClaim == null;
}
function recoveredReleaseOperation(op: DocumentData | undefined, input: RecoveredGatewayReleaseInput): boolean {
  return op?.kind === "restart-gateway" && op.status === "running" && op.startedAt === input.claimedStartedAt &&
    typeof input.claimedStartedAt === "number" && op.cancellationRequestedAt === undefined && op.input?.gatewayId === input.gatewayId &&
    Array.isArray(op.input?.sourceRecovery?.postgresAgentStores) && op.input.sourceRecovery.postgresAgentStores.length > 0;
}
function recoveredReleasePayload(recovery: DocumentData | undefined, payload: ReleasePayload, images: Record<string, string>): boolean {
  return isReleasePayload(payload) && payload.gatewayEdgeImage !== undefined && isDeepStrictEqual(recovery?.payload, payload) &&
    isDeepStrictEqual(recovery?.images, images);
}
function recoveredReleaseDoctor(fence: DocumentData | undefined, operationId: string, images: Record<string, string>): boolean {
  const doctor = fence?.doctor;
  return fence?.kind === "source-recovery" && fence.attemptId === operationId && fence.phase === "dispatched" &&
    doctor?.requestId === operationId && doctor?.error === undefined && recoveredDoctorTiming(doctor) && isDeepStrictEqual(fence.target?.images, images);
}
function recoveredDoctorTiming(doctor: DocumentData | undefined): boolean {
  return doctor !== undefined && Number.isSafeInteger(doctor.startedAt) && Number.isSafeInteger(doctor.completedAt) && doctor.completedAt >= doctor.startedAt;
}
export async function recordRecoveredGatewayRelease(db: Firestore, transaction: Transaction, input: RecoveredGatewayReleaseInput): Promise<{ release: number; operationId: string }> {
  const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
  const [snapshot, operation] = await Promise.all([transaction.get(gatewayRef),
    transaction.get(db.collection(GLM_OPERATIONS_COLLECTION).doc(input.operationId))]);
  const current = asDurableGatewayRoot(snapshot.data(), input.gatewayId), op = operation.data();
  const recovery = op?.input?.sourceRecovery, fence = snapshot.data()?.runtimeRestartFence;
  const images = { gateway: `${input.payload.imageRepository}:${input.payload.imageTag}`,
    "gateway-edge": `${input.payload.gatewayEdgeImage?.imageRepository}:${input.payload.gatewayEdgeImage?.imageTag}` };
  if (!recoveredSharedRoot(current) || !recoveredReleaseOperation(op, input) || !recoveredReleasePayload(recovery, input.payload, images) ||
      !recoveredReleaseDoctor(fence, input.operationId, images)) {
    throw new Error("recovered Shared release authority changed");
  }
  const release = current.latestRelease + 1;
  await assertReleaseIsNew(transaction, gatewayRef, input.gatewayId, release);
  const operationRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
  writeGatewayRelease(transaction, gatewayRef, operationRef, {
    gateway: current, artifact: gatewayArtifactFromReleasePayload(input.payload), payload: input.payload,
    createdBy: input.operationId, now: input.now, sourceRelease: current.liveRelease,
    note: "Stopped-source PostgreSQL repair", origin: "operator",
  }, { release, payload: input.payload, activate: true });
  return { release, operationId: operationRef.id };
}
