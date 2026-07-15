import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION, } from "@octogee/shared/types/glm";
import { isGatewayDesiredDoc, isRevisionRealizationDoc, revisionIdForRelease, } from "@octogee/shared/types/gateway-releases";
export class GatewayRetirementConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = "GatewayRetirementConflictError";
    }
}
function isPlainRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
export function hasGatewayRetirementConfigObligation(status) {
    if (!isPlainRecord(status))
        return false;
    return (status.freezeState === "freezing" ||
        status.freezeState === "frozen" ||
        status.bootRole === "source-frozen" ||
        status.bootRole === "target-candidate" ||
        isPlainRecord(status.controlOwner) ||
        nonEmptyString(status.candidateCommit) ||
        nonEmptyString(status.candidateHash));
}
function heartbeatFromRevision(revision) {
    if (!isPlainRecord(revision) || !isPlainRecord(revision.heartbeat))
        return null;
    return revision.heartbeat;
}
function revisionConfigStatus(revision) {
    const heartbeat = heartbeatFromRevision(revision);
    return heartbeat?.configStatus;
}
function mountedCustomers(revision) {
    const heartbeat = heartbeatFromRevision(revision);
    if (!heartbeat || !Array.isArray(heartbeat.mountedCustomers))
        return [];
    return heartbeat.mountedCustomers.filter((customer) => typeof customer === "string" && customer.length > 0);
}
function hasRootConfigControlObligation(root) {
    return root.roll != null || root.systemConfigRoll != null;
}
function exactLiveRevisionError(gatewayId, root, revision) {
    const liveRevisionId = root.liveRevisionId;
    const liveRelease = root.liveRelease;
    if (liveRevisionId === null && liveRelease === null)
        return null;
    if (typeof liveRevisionId !== "string" ||
        !Number.isInteger(liveRelease) ||
        liveRelease <= 0 ||
        root.trafficRevisionId !== liveRevisionId ||
        liveRevisionId !== revisionIdForRelease(gatewayId, liveRelease) ||
        !isRevisionRealizationDoc(revision) ||
        revision.revisionId !== liveRevisionId ||
        revision.gateway !== gatewayId ||
        revision.release !== liveRelease) {
        return `gateway ${gatewayId} exact live revision telemetry is unavailable`;
    }
    return null;
}
function readClaim(value) {
    if (!isPlainRecord(value))
        return null;
    if (typeof value.operationId !== "string" ||
        !Number.isInteger(value.version) ||
        value.version <= 0 ||
        typeof value.claimedAt !== "number" ||
        !Number.isFinite(value.claimedAt) ||
        (value.previousDesiredStatus !== "running" && value.previousDesiredStatus !== "paused") ||
        !((value.liveRevisionId === null && value.liveRelease === null) ||
            (typeof value.liveRevisionId === "string" &&
                Number.isInteger(value.liveRelease) &&
                value.liveRelease > 0))) {
        return null;
    }
    return value;
}
function nextRetirementVersion(value) {
    if (value === undefined || value === null)
        return 1;
    if (!Number.isInteger(value) || value < 0) {
        throw new GatewayRetirementConflictError("gateway retirement version is invalid");
    }
    return value + 1;
}
function operationInput(operation) {
    if (!isPlainRecord(operation.input)) {
        throw new Error("retirement operation input must be an object");
    }
    return operation.input;
}
export async function claimGatewayRetirementAtomic(input) {
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
        const root = rootData;
        if (rootData.desiredStatus === "retired") {
            throw new GatewayRetirementConflictError(`gateway ${input.gatewayId} is already retired`);
        }
        if (root.retirementClaim != null) {
            throw new GatewayRetirementConflictError(`gateway ${input.gatewayId} already has a retirement claim`);
        }
        if (hasRootConfigControlObligation(root)) {
            throw new GatewayRetirementConflictError(`gateway ${input.gatewayId} has an unfinished release roll and config obligation`);
        }
        let revision;
        if (typeof rootData.liveRevisionId === "string") {
            const revisionSnap = await transaction.get(input.db.collection(GLM_GATEWAYS_COLLECTION).doc(rootData.liveRevisionId));
            revision = revisionSnap.exists ? revisionSnap.data() : undefined;
        }
        const revisionError = exactLiveRevisionError(input.gatewayId, root, revision);
        if (revisionError)
            throw new GatewayRetirementConflictError(revisionError);
        if (hasGatewayRetirementConfigObligation(revisionConfigStatus(revision))) {
            throw new GatewayRetirementConflictError(`gateway ${input.gatewayId} live revision has an active config-control obligation`);
        }
        const mounted = mountedCustomers(revision);
        if (mounted.length > 0) {
            throw new GatewayRetirementConflictError(`gateway ${input.gatewayId} still has mounted customers: ${mounted.join(", ")}`);
        }
        const version = nextRetirementVersion(root.retirementVersion);
        const claim = {
            operationId: input.operationId,
            version,
            claimedAt: input.now,
            liveRevisionId: rootData.liveRevisionId,
            liveRelease: rootData.liveRelease,
            previousDesiredStatus: rootData.desiredStatus,
        };
        transaction.set(rootRef, {
            desiredStatus: "retired",
            retirementVersion: version,
            retirementClaim: claim,
            updatedAt: input.now,
            updatedBy: input.updatedBy,
        }, { merge: true });
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
function rejectionForCurrentState(gatewayId, root, claim, revision) {
    if (root.liveRevisionId !== claim.liveRevisionId ||
        root.liveRelease !== claim.liveRelease) {
        return `gateway ${gatewayId} live revision changed after retirement claim`;
    }
    if (hasRootConfigControlObligation(root)) {
        return `gateway ${gatewayId} has an unfinished release roll and config obligation`;
    }
    const revisionError = exactLiveRevisionError(gatewayId, root, revision);
    if (revisionError)
        return revisionError;
    if (hasGatewayRetirementConfigObligation(revisionConfigStatus(revision))) {
        return `gateway ${gatewayId} live revision has an active config-control obligation`;
    }
    const mounted = mountedCustomers(revision);
    if (mounted.length > 0) {
        return `gateway ${gatewayId} still has mounted customers: ${mounted.join(", ")}`;
    }
    return null;
}
export async function verifyGatewayRetirementClaimAtomic(input) {
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
        const root = rootData;
        const claim = readClaim(root.retirementClaim);
        if (!claim ||
            claim.operationId !== input.operationId ||
            claim.version !== input.version) {
            return {
                ok: false,
                error: `gateway ${input.gatewayId} retirement claim does not match operation ${input.operationId}`,
            };
        }
        let revision;
        if (typeof rootData.liveRevisionId === "string") {
            const revisionSnap = await transaction.get(input.db.collection(GLM_GATEWAYS_COLLECTION).doc(rootData.liveRevisionId));
            revision = revisionSnap.exists ? revisionSnap.data() : undefined;
        }
        const stateError = rootData.desiredStatus !== "retired"
            ? `gateway ${input.gatewayId} desiredStatus is no longer retired`
            : rejectionForCurrentState(input.gatewayId, root, claim, revision);
        if (!stateError)
            return { ok: true };
        transaction.set(rootRef, {
            ...(rootData.desiredStatus === "retired"
                ? { desiredStatus: claim.previousDesiredStatus }
                : {}),
            retirementClaim: null,
            updatedAt: input.now,
            updatedBy: input.updatedBy,
        }, { merge: true });
        return { ok: false, error: stateError };
    });
}
