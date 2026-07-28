import { randomUUID } from "node:crypto";
import type {
  OperationAuditAliasOutcome,
  OperationAuditPartialOutcome,
  OperationAuditReleaseRolloutLinkage,
} from "@octogee/shared/types/glm";
import {
  claimOperationAuditAction,
  finishOperationAudit,
  recordOperationAuditIntent,
  type OperationAuditActionClaim,
  type OperationAuditIntentInput,
  type OperationsDb,
  type OperationsDocRef,
} from "./operation-audit.js";

export const GLM_MAINTENANCE_DOC_PATH = "config/glmMaintenance";

export interface NormalFleetMutationDb extends OperationsDb {
  doc(path: string): OperationsDocRef;
}

interface MaintenanceGateSnapshot {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export class FleetMutationFrozenError extends Error {
  constructor(readonly reason: string | null) {
    super(
      reason
        ? `maintenance freeze blocks fleet mutation: ${reason}`
        : "maintenance freeze blocks fleet mutation",
    );
    this.name = "FleetMutationFrozenError";
  }
}

export class FleetMutationMaintenanceUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `maintenance gate is unavailable; blocking fleet mutation: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "FleetMutationMaintenanceUnavailableError";
  }
}

export class FleetMutationIdempotencyError extends Error {
  constructor(readonly auditId: string, readonly status: "recorded" | "in-progress" | "completed" | "failed") {
    super(`fleet mutation with this Idempotency-Key is already ${status}`);
    this.name = "FleetMutationIdempotencyError";
  }
}

function maintenanceFreezeReason(data: Record<string, unknown> | undefined): string | null {
  if (data?.mode === "open") return null;
  if (data?.mode === "frozen") {
    return typeof data.reason === "string" && data.reason.length > 0 ? data.reason : null;
  }
  return `invalid ${GLM_MAINTENANCE_DOC_PATH} document`;
}

export async function assertNormalFleetMutationOpen(db: NormalFleetMutationDb): Promise<void> {
  let snapshot: Awaited<ReturnType<OperationsDocRef["get"]>>;
  try {
    snapshot = await db.doc(GLM_MAINTENANCE_DOC_PATH).get();
  } catch (error) {
    throw new FleetMutationMaintenanceUnavailableError(error);
  }
  assertNormalFleetMutationSnapshotOpen(snapshot);
}

export function assertNormalFleetMutationSnapshotOpen(
  snapshot: MaintenanceGateSnapshot,
): void {
  if (!snapshot.exists) return;
  const reason = maintenanceFreezeReason(snapshot.data());
  if (reason !== null || snapshot.data()?.mode !== "open") {
    throw new FleetMutationFrozenError(reason);
  }
}

export type NormalFleetMutationResult =
  | {
      outcome: "completed";
      aliasOutcomes?: OperationAuditAliasOutcome[];
      releaseRollout?: OperationAuditReleaseRolloutLinkage;
    }
  | {
      outcome: "partial";
      partialOutcome: OperationAuditPartialOutcome;
      aliasOutcomes?: OperationAuditAliasOutcome[];
      releaseRollout?: OperationAuditReleaseRolloutLinkage;
    }
  | {
      outcome: "failed";
      error: string;
      partialOutcome?: OperationAuditPartialOutcome;
      aliasOutcomes?: OperationAuditAliasOutcome[];
      releaseRollout?: OperationAuditReleaseRolloutLinkage;
    };

export class FleetMutationPartialError extends Error {
  constructor(
    message: string,
    readonly partialOutcome: OperationAuditPartialOutcome,
    readonly aliasOutcomes?: OperationAuditAliasOutcome[],
    readonly releaseRollout?: OperationAuditReleaseRolloutLinkage,
  ) {
    super(message);
    this.name = "FleetMutationPartialError";
  }
}

export interface NormalFleetMutationInput<T> extends OperationAuditIntentInput {
  claimId?: string;
  action: (claim: OperationAuditActionClaim) => Promise<T>;
  classifyResult?: (result: T) => NormalFleetMutationResult;
}

export async function runNormalFleetMutation<T>(
  db: NormalFleetMutationDb,
  input: NormalFleetMutationInput<T>,
): Promise<T> {
  await assertNormalFleetMutationOpen(db);
  const { action, claimId, classifyResult, idempotencyKey, ...intent } = input;
  const audit = await recordOperationAuditIntent(db, {
    ...intent,
    idempotencyKey: idempotencyKey ?? randomUUID(),
  });
  if (audit.disposition === "existing") {
    throw new FleetMutationIdempotencyError(audit.auditId, audit.status);
  }
  const claim = await claimOperationAuditAction(db, audit.auditId, {
    claimId: claimId ?? randomUUID(),
  });
  let result: T;
  let outcome: NormalFleetMutationResult;
  try {
    await assertNormalFleetMutationOpen(db);
    result = await action(claim);
    outcome = classifyResult?.(result) ?? { outcome: "completed" };
  } catch (error) {
    try {
      const partial = error instanceof FleetMutationPartialError ? error : null;
      await finishOperationAudit(db, audit.auditId, {
        expectedClaimId: claim.claimId,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
        ...(partial ? {
          partialOutcome: partial.partialOutcome,
          ...(partial.aliasOutcomes ? { aliasOutcomes: partial.aliasOutcomes } : {}),
          ...(partial.releaseRollout ? { releaseRollout: partial.releaseRollout } : {}),
        } : {}),
      });
    } catch (completionError) {
      throw new AggregateError(
        [error, completionError],
        `operation audit ${audit.auditId} action failed and its failure could not be recorded`,
      );
    }
    throw error;
  }
  await finishOperationAudit(db, audit.auditId, {
    expectedClaimId: claim.claimId,
    ...outcome,
  });
  return result;
}
