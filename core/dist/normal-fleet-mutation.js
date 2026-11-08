import { randomUUID } from "node:crypto";
import { claimOperationAuditAction, finishOperationAudit, recordOperationAuditIntent, } from "./operation-audit.js";
export class FleetMutationIdempotencyError extends Error {
    auditId;
    status;
    constructor(auditId, status) {
        super(`fleet mutation with this Idempotency-Key is already ${status}`);
        this.auditId = auditId;
        this.status = status;
        this.name = "FleetMutationIdempotencyError";
    }
}
export class FleetMutationPartialError extends Error {
    partialOutcome;
    aliasOutcomes;
    releaseRollout;
    constructor(message, partialOutcome, aliasOutcomes, releaseRollout) {
        super(message);
        this.partialOutcome = partialOutcome;
        this.aliasOutcomes = aliasOutcomes;
        this.releaseRollout = releaseRollout;
        this.name = "FleetMutationPartialError";
    }
}
export async function runNormalFleetMutation(store, input) {
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
    let result;
    let outcome;
    try {
        result = await action(claim);
        outcome = classifyResult?.(result) ?? { outcome: "completed" };
    }
    catch (error) {
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
        }
        catch (completionError) {
            throw new AggregateError([error, completionError], `operation audit ${audit.auditId} action failed and its failure could not be recorded`);
        }
        throw error;
    }
    await finishOperationAudit(store, audit.auditId, {
        expectedClaimId: claim.claimId,
        ...outcome,
    });
    return result;
}
