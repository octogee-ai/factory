import type { DocumentReference, Firestore, Transaction } from "firebase-admin/firestore";
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
import { GatewayRetirementConflictError } from "./gateway-retirement-claim.js";

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

export interface AppendGatewayReleaseArgs {
  gateway: GatewayDoc;
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
    const release = current.latestRelease + 1;
    const releaseRef = gatewayRef.collection(GATEWAY_RELEASES_SUBCOLLECTION).doc(String(release));
    await assertReleaseIsNew(transaction, gatewayRef, args.gateway.gatewayId, release);
    const payload = releasePayloadFor(args);
    const artifact = gatewayArtifactFromReleasePayload(payload);
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
    transaction.set(releaseRef, releaseDoc as unknown as Record<string, unknown>);
    transaction.update(gatewayRef, {
      latestRelease: release,
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
      input: rolloutOperationInput(args.gateway.gatewayId, release, artifact),
      steps: [],
      gatewayId: args.gateway.gatewayId,
    });
    return { release, operationId: operationRef.id };
  });
}
