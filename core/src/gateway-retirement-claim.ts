import type { Firestore } from "firebase-admin/firestore";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
} from "@octogee/shared/types/glm";
import {
  isGatewayDesiredDoc,
  isRevisionRealizationDoc,
  revisionIdForRelease,
  type GatewayRetirementClaim as RetirementClaim,
} from "@octogee/shared/types/gateway-releases";

export class GatewayRetirementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayRetirementConflictError";
  }
}

interface RetirementOperation {
  input?: unknown;
  [key: string]: unknown;
}

interface ClaimGatewayRetirementInput {
  db: Firestore;
  gatewayId: string;
  operationId: string;
  operation: RetirementOperation;
  now: number;
  updatedBy: string;
}

interface VerifyGatewayRetirementClaimInput {
  db: Firestore;
  gatewayId: string;
  operationId: string;
  version: number;
  now: number;
  updatedBy: string;
}

export type GatewayRetirementVerification =
  | { ok: true }
  | { ok: false; error: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

export function hasGatewayRetirementConfigObligation(status: unknown): boolean {
  if (!isPlainRecord(status)) return false;
  return (
    status.freezeState === "freezing" ||
    status.freezeState === "frozen" ||
    status.bootRole === "source-frozen" ||
    status.bootRole === "target-candidate" ||
    isPlainRecord(status.controlOwner) ||
    nonEmptyString(status.candidateCommit) ||
    nonEmptyString(status.candidateHash)
  );
}

function heartbeatFromRevision(revision: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(revision) || !isPlainRecord(revision.heartbeat)) return null;
  return revision.heartbeat;
}

function revisionConfigStatus(revision: unknown): unknown {
  const heartbeat = heartbeatFromRevision(revision);
  return heartbeat?.configStatus;
}

function mountedCustomers(revision: unknown): string[] {
  const heartbeat = heartbeatFromRevision(revision);
  if (!heartbeat || !Array.isArray(heartbeat.mountedCustomers)) return [];
  return heartbeat.mountedCustomers.filter(
    (customer): customer is string => typeof customer === "string" && customer.length > 0,
  );
}

function hasRootConfigControlObligation(root: Record<string, unknown>): boolean {
  return root.roll != null || root.systemConfigRoll != null;
}

function exactLiveRevisionError(
  gatewayId: string,
  root: Record<string, unknown>,
  revision: unknown,
): string | null {
  const liveRevisionId = root.liveRevisionId;
  const liveRelease = root.liveRelease;
  if (liveRevisionId === null && liveRelease === null) return null;
  if (
    typeof liveRevisionId !== "string" ||
    !Number.isInteger(liveRelease) ||
    (liveRelease as number) <= 0 ||
    root.trafficRevisionId !== liveRevisionId ||
    liveRevisionId !== revisionIdForRelease(gatewayId, liveRelease as number) ||
    !isRevisionRealizationDoc(revision) ||
    revision.revisionId !== liveRevisionId ||
    revision.gateway !== gatewayId ||
    revision.release !== liveRelease
  ) {
    return `gateway ${gatewayId} exact live revision telemetry is unavailable`;
  }
  return null;
}

function readClaim(value: unknown): RetirementClaim | null {
  if (!isPlainRecord(value)) return null;
  if (
    typeof value.operationId !== "string" ||
    !Number.isInteger(value.version) ||
    (value.version as number) <= 0 ||
    typeof value.claimedAt !== "number" ||
    !Number.isFinite(value.claimedAt) ||
    (value.previousDesiredStatus !== "running" && value.previousDesiredStatus !== "paused") ||
    !(
      (value.liveRevisionId === null && value.liveRelease === null) ||
      (typeof value.liveRevisionId === "string" &&
        Number.isInteger(value.liveRelease) &&
        (value.liveRelease as number) > 0)
    )
  ) {
    return null;
  }
  return value as unknown as RetirementClaim;
}

function nextRetirementVersion(value: unknown): number {
  if (value === undefined || value === null) return 1;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new GatewayRetirementConflictError("gateway retirement version is invalid");
  }
  return (value as number) + 1;
}

function operationInput(operation: RetirementOperation): Record<string, unknown> {
  if (!isPlainRecord(operation.input)) {
    throw new Error("retirement operation input must be an object");
  }
  return operation.input;
}

export async function claimGatewayRetirementAtomic(
  input: ClaimGatewayRetirementInput,
): Promise<{ version: number }> {
  const rootRef = input.db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
  const operationRef = input.db
    .collection(GLM_OPERATIONS_COLLECTION)
    .doc(input.operationId);

  return input.db.runTransaction(async (transaction) => {
    const rootSnap = await transaction.get(rootRef);
    const rootData = rootSnap.exists ? rootSnap.data() : undefined;
    if (!isGatewayDesiredDoc(rootData) || rootData.gatewayId !== input.gatewayId) {
      throw new GatewayRetirementConflictError(`gateway ${input.gatewayId} durable root is unavailable`);
    }
    const root = rootData as unknown as Record<string, unknown>;
    if (rootData.desiredStatus === "retired") {
      throw new GatewayRetirementConflictError(`gateway ${input.gatewayId} is already retired`);
    }
    if (root.retirementClaim != null) {
      throw new GatewayRetirementConflictError(
        `gateway ${input.gatewayId} already has a retirement claim`,
      );
    }
    if (hasRootConfigControlObligation(root)) {
      throw new GatewayRetirementConflictError(
        `gateway ${input.gatewayId} has an unfinished release roll and config obligation`,
      );
    }

    let revision: unknown;
    if (typeof rootData.liveRevisionId === "string") {
      const revisionSnap = await transaction.get(
        input.db.collection(GLM_GATEWAYS_COLLECTION).doc(rootData.liveRevisionId),
      );
      revision = revisionSnap.exists ? revisionSnap.data() : undefined;
    }
    const revisionError = exactLiveRevisionError(input.gatewayId, root, revision);
    if (revisionError) throw new GatewayRetirementConflictError(revisionError);
    if (hasGatewayRetirementConfigObligation(revisionConfigStatus(revision))) {
      throw new GatewayRetirementConflictError(
        `gateway ${input.gatewayId} live revision has an active config-control obligation`,
      );
    }
    const mounted = mountedCustomers(revision);
    if (mounted.length > 0) {
      throw new GatewayRetirementConflictError(
        `gateway ${input.gatewayId} still has mounted customers: ${mounted.join(", ")}`,
      );
    }

    const version = nextRetirementVersion(root.retirementVersion);
    const claim: RetirementClaim = {
      operationId: input.operationId,
      version,
      claimedAt: input.now,
      liveRevisionId: rootData.liveRevisionId,
      liveRelease: rootData.liveRelease,
      previousDesiredStatus: rootData.desiredStatus,
    };
    transaction.set(
      rootRef,
      {
        desiredStatus: "retired",
        retirementVersion: version,
        retirementClaim: claim,
        updatedAt: input.now,
        updatedBy: input.updatedBy,
      },
      { merge: true },
    );
    transaction.set(operationRef, {
      ...input.operation,
      input: {
        ...operationInput(input.operation),
        retirementClaimVersion: version,
      },
    });
    return { version };
  });
}

function rejectionForCurrentState(
  gatewayId: string,
  root: Record<string, unknown>,
  claim: RetirementClaim,
  revision: unknown,
): string | null {
  if (
    root.liveRevisionId !== claim.liveRevisionId ||
    root.liveRelease !== claim.liveRelease
  ) {
    return `gateway ${gatewayId} live revision changed after retirement claim`;
  }
  if (hasRootConfigControlObligation(root)) {
    return `gateway ${gatewayId} has an unfinished release roll and config obligation`;
  }
  const revisionError = exactLiveRevisionError(gatewayId, root, revision);
  if (revisionError) return revisionError;
  if (hasGatewayRetirementConfigObligation(revisionConfigStatus(revision))) {
    return `gateway ${gatewayId} live revision has an active config-control obligation`;
  }
  const mounted = mountedCustomers(revision);
  if (mounted.length > 0) {
    return `gateway ${gatewayId} still has mounted customers: ${mounted.join(", ")}`;
  }
  return null;
}

export async function verifyGatewayRetirementClaimAtomic(
  input: VerifyGatewayRetirementClaimInput,
): Promise<GatewayRetirementVerification> {
  const rootRef = input.db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
  return input.db.runTransaction(async (transaction) => {
    const rootSnap = await transaction.get(rootRef);
    const rootData = rootSnap.exists ? rootSnap.data() : undefined;
    if (!isGatewayDesiredDoc(rootData) || rootData.gatewayId !== input.gatewayId) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} durable retirement state is unavailable`,
      };
    }
    const root = rootData as unknown as Record<string, unknown>;
    const claim = readClaim(root.retirementClaim);
    if (
      !claim ||
      claim.operationId !== input.operationId ||
      claim.version !== input.version
    ) {
      return {
        ok: false,
        error: `gateway ${input.gatewayId} retirement claim does not match operation ${input.operationId}`,
      };
    }

    let revision: unknown;
    if (typeof rootData.liveRevisionId === "string") {
      const revisionSnap = await transaction.get(
        input.db.collection(GLM_GATEWAYS_COLLECTION).doc(rootData.liveRevisionId),
      );
      revision = revisionSnap.exists ? revisionSnap.data() : undefined;
    }
    const stateError = rootData.desiredStatus !== "retired"
      ? `gateway ${input.gatewayId} desiredStatus is no longer retired`
      : rejectionForCurrentState(input.gatewayId, root, claim, revision);
    if (!stateError) return { ok: true };

    transaction.set(
      rootRef,
      {
        ...(rootData.desiredStatus === "retired"
          ? { desiredStatus: claim.previousDesiredStatus }
          : {}),
        retirementClaim: null,
        updatedAt: input.now,
        updatedBy: input.updatedBy,
      },
      { merge: true },
    );
    return { ok: false, error: stateError };
  });
}
