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
} from "./operation-audit.js";
import type { PlatformStateStore } from "./platform-state/store.js";

export class FleetMutationIdempotencyError extends Error {
  constructor(readonly auditId: string, readonly status: "recorded" | "in-progress" | "completed" | "failed") {
    super(`fleet mutation with this Idempotency-Key is already ${status}`);
    this.name = "FleetMutationIdempotencyError";
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
  store: PlatformStateStore,
  input: NormalFleetMutationInput<T>,
): Promise<T> {
  const { action, claimId, classifyResult, idempotencyKey, ...intent } = input;
  const audit = await recordOperationAuditIntent(store, {
    ...intent,
    idempotencyKey: idempotencyKey ?? randomUUID(),
  });
  if (audit.disposition === "existing") {
    throw new FleetMutationIdempotencyError(audit.auditId, audit.status);
  }
  const claim = await claimOperationAuditAction(store, audit.auditId, {
    claimId: claimId ?? randomUUID(),
  });
  let result: T;
  let outcome: NormalFleetMutationResult;
  try {
    result = await action(claim);
    outcome = classifyResult?.(result) ?? { outcome: "completed" };
  } catch (error) {
    try {
      const partial = error instanceof FleetMutationPartialError ? error : null;
      await finishOperationAudit(store, audit.auditId, {
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
  await finishOperationAudit(store, audit.auditId, {
    expectedClaimId: claim.claimId,
    ...outcome,
  });
  return result;
}
