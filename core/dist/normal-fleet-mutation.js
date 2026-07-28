import { randomUUID } from "node:crypto";
import { claimOperationAuditAction, finishOperationAudit, recordOperationAuditIntent, } from "./operation-audit.js";
export const GLM_MAINTENANCE_DOC_PATH = "config/glmMaintenance";
export class FleetMutationFrozenError extends Error {
    reason;
    constructor(reason) {
        super(reason
            ? `maintenance freeze blocks fleet mutation: ${reason}`
            : "maintenance freeze blocks fleet mutation");
        this.reason = reason;
        this.name = "FleetMutationFrozenError";
    }
}
export class FleetMutationMaintenanceUnavailableError extends Error {
    constructor(cause) {
        super(`maintenance gate is unavailable; blocking fleet mutation: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = "FleetMutationMaintenanceUnavailableError";
    }
}
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
function maintenanceFreezeReason(data) {
    if (data?.mode === "open")
        return null;
    if (data?.mode === "frozen") {
        return typeof data.reason === "string" && data.reason.length > 0 ? data.reason : null;
    }
    return `invalid ${GLM_MAINTENANCE_DOC_PATH} document`;
}
export async function assertNormalFleetMutationOpen(db) {
    let snapshot;
    try {
        snapshot = await db.doc(GLM_MAINTENANCE_DOC_PATH).get();
    }
    catch (error) {
        throw new FleetMutationMaintenanceUnavailableError(error);
    }
    assertNormalFleetMutationSnapshotOpen(snapshot);
}
export function assertNormalFleetMutationSnapshotOpen(snapshot) {
    if (!snapshot.exists)
        return;
    const reason = maintenanceFreezeReason(snapshot.data());
    if (reason !== null || snapshot.data()?.mode !== "open") {
        throw new FleetMutationFrozenError(reason);
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
export async function runNormalFleetMutation(db, input) {
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
    let result;
    let outcome;
    try {
        await assertNormalFleetMutationOpen(db);
        result = await action(claim);
        outcome = classifyResult?.(result) ?? { outcome: "completed" };
    }
    catch (error) {
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
        }
        catch (completionError) {
            throw new AggregateError([error, completionError], `operation audit ${audit.auditId} action failed and its failure could not be recorded`);
        }
        throw error;
    }
    await finishOperationAudit(db, audit.auditId, {
        expectedClaimId: claim.claimId,
        ...outcome,
    });
    return result;
}
