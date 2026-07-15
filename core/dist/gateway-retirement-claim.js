import { GATEWAY_HEARTBEAT_INTERVAL_MS, GATEWAY_UNREACHABLE_AFTER_MS, GATEWAYS_COLLECTION, hasDurableOpenClawConfigControlProtocol, } from "@octogee/shared/types/fleet-controller";
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
function millis(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (value instanceof Date)
        return value.getTime();
    if (value &&
        typeof value === "object" &&
        typeof value.toMillis === "function") {
        try {
            const result = value.toMillis();
            return typeof result === "number" && Number.isFinite(result) ? result : null;
        }
        catch {
            return null;
        }
    }
    return null;
}
function freshObservation(value, now) {
    const observedAt = millis(value);
    return observedAt !== null &&
        observedAt <= now + GATEWAY_HEARTBEAT_INTERVAL_MS &&
        now - observedAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}
function hasRootConfigControlObligation(root) {
    return root.roll != null || root.systemConfigRoll != null;
}
function canonicalRevision(gatewayId, view) {
    const revision = view.data;
    if (!isRevisionRealizationDoc(revision))
        return null;
    return revision.gateway === gatewayId &&
        revision.revisionId === view.id &&
        Number.isInteger(revision.release) &&
        revision.release > 0 &&
        view.id === revisionIdForRelease(gatewayId, revision.release)
        ? revision
        : null;
}
function hasSafeDedicatedConfigTelemetry(heartbeat, status, now) {
    return !!status &&
        hasDurableOpenClawConfigControlProtocol(status) &&
        freshObservation(status.observedAt, now) &&
        status.runtimeReady === true &&
        status.freezeState === "unfrozen" &&
        status.bootRole === "normal" &&
        nonEmptyString(heartbeat.openclawVersion) &&
        status.openclawVersion === heartbeat.openclawVersion;
}
function nonRetiredRevisionError(gatewayId, liveRevisionId, revision, now, configControlRequired) {
    if (revision.lifecycle === "retired")
        return null;
    const heartbeat = heartbeatFromRevision(revision);
    if (!heartbeat ||
        !Array.isArray(heartbeat.mountedCustomers) ||
        !heartbeat.mountedCustomers.every((customer) => typeof customer === "string" && customer.length > 0)) {
        return `gateway ${gatewayId} revision ${revision.revisionId} mount telemetry is unavailable`;
    }
    if (heartbeat.mountedCustomers.length > 0) {
        return `gateway ${gatewayId} revision ${revision.revisionId} still has mounted customers: ${heartbeat.mountedCustomers.join(", ")}`;
    }
    if (!freshObservation(heartbeat.lastHeartbeatAt, now)) {
        return `gateway ${gatewayId} revision ${revision.revisionId} telemetry is stale or unavailable`;
    }
    if (hasGatewayRetirementConfigObligation(heartbeat.configStatus)) {
        return revision.revisionId === liveRevisionId
            ? `gateway ${gatewayId} live revision has an active config-control obligation`
            : `gateway ${gatewayId} revision ${revision.revisionId} has an active config-control obligation`;
    }
    const status = isPlainRecord(heartbeat.configStatus) ? heartbeat.configStatus : null;
    if (configControlRequired &&
        !hasSafeDedicatedConfigTelemetry(heartbeat, status, now)) {
        return `gateway ${gatewayId} revision ${revision.revisionId} config telemetry is stale or unavailable`;
    }
    return null;
}
function liveRuntimeIdentity(revision, now, configControlRequired) {
    const heartbeat = heartbeatFromRevision(revision);
    const status = heartbeat && isPlainRecord(heartbeat.configStatus)
        ? heartbeat.configStatus
        : null;
    if (!revision || !heartbeat)
        return null;
    const complete = [
        revision.lifecycle === "serving",
        heartbeat.status === "ready",
        freshObservation(heartbeat.lastHeartbeatAt, now),
        typeof heartbeat.startedAt === "number" && Number.isFinite(heartbeat.startedAt),
        nonEmptyString(heartbeat.version),
        nonEmptyString(heartbeat.openclawVersion),
        !configControlRequired || hasSafeDedicatedConfigTelemetry(heartbeat, status, now),
    ].every(Boolean);
    return complete
        ? {
            startedAt: heartbeat.startedAt,
            version: heartbeat.version,
            openclawVersion: heartbeat.openclawVersion,
        }
        : null;
}
function inspectRetirementState(gatewayId, root, revisions, now) {
    const configControlRequired = root.gatewayClass !== "shared";
    const liveRevisionId = root.liveRevisionId;
    const liveRelease = root.liveRelease;
    if (typeof liveRevisionId !== "string" ||
        !Number.isInteger(liveRelease) ||
        liveRelease <= 0 ||
        root.trafficRevisionId !== liveRevisionId ||
        liveRevisionId !== revisionIdForRelease(gatewayId, liveRelease)) {
        return {
            error: `gateway ${gatewayId} exact live revision telemetry is unavailable`,
            liveRuntimeIdentity: null,
        };
    }
    let liveRevision = null;
    for (const view of revisions) {
        const revision = canonicalRevision(gatewayId, view);
        if (!revision) {
            return {
                error: `gateway ${gatewayId} revision ${view.id} telemetry is invalid`,
                liveRuntimeIdentity: null,
            };
        }
        if (view.id === liveRevisionId)
            liveRevision = revision;
        const error = nonRetiredRevisionError(gatewayId, liveRevisionId, revision, now, configControlRequired);
        if (error) {
            return {
                error,
                liveRuntimeIdentity: null,
            };
        }
    }
    if (!isRevisionRealizationDoc(liveRevision) ||
        liveRevision.revisionId !== liveRevisionId ||
        liveRevision.gateway !== gatewayId ||
        liveRevision.release !== liveRelease) {
        return {
            error: `gateway ${gatewayId} exact live revision telemetry is unavailable`,
            liveRuntimeIdentity: null,
        };
    }
    const identity = liveRuntimeIdentity(liveRevision, now, configControlRequired);
    if (!identity) {
        return {
            error: `gateway ${gatewayId} exact live revision telemetry/config status is unavailable`,
            liveRuntimeIdentity: null,
        };
    }
    return {
        error: null,
        liveRuntimeIdentity: identity,
    };
}
function runtimeIdentity(value) {
    if (!isPlainRecord(value))
        return null;
    if (typeof value.startedAt !== "number" ||
        !Number.isFinite(value.startedAt) ||
        !nonEmptyString(value.version) ||
        !nonEmptyString(value.openclawVersion)) {
        return null;
    }
    return {
        startedAt: value.startedAt,
        version: value.version,
        openclawVersion: value.openclawVersion,
    };
}
function sameRuntimeIdentity(left, right) {
    if (!left || !right)
        return left === right;
    return left.startedAt === right.startedAt &&
        left.version === right.version &&
        left.openclawVersion === right.openclawVersion;
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
        typeof value.liveRevisionId !== "string" ||
        !Number.isInteger(value.liveRelease) ||
        value.liveRelease <= 0 ||
        runtimeIdentity(value.liveRuntimeIdentity) === null) {
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
        if (rootData.desiredRelease !== rootData.liveRelease) {
            throw new GatewayRetirementConflictError(`gateway ${input.gatewayId} desired release is not converged to live`);
        }
        const revisionsSnap = await transaction.get(input.db.collection(GLM_GATEWAYS_COLLECTION).where("gateway", "==", input.gatewayId));
        const inspection = inspectRetirementState(input.gatewayId, root, revisionsSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() })), input.now);
        if (inspection.error)
            throw new GatewayRetirementConflictError(inspection.error);
        const version = nextRetirementVersion(root.retirementVersion);
        const claim = {
            operationId: input.operationId,
            version,
            claimedAt: input.now,
            liveRevisionId: rootData.liveRevisionId,
            liveRelease: rootData.liveRelease,
            liveRuntimeIdentity: inspection.liveRuntimeIdentity,
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
function rejectionForCurrentState(gatewayId, root, claim, revisions, now) {
    if (root.liveRevisionId !== claim.liveRevisionId ||
        root.liveRelease !== claim.liveRelease) {
        return `gateway ${gatewayId} live revision changed after retirement claim`;
    }
    if (hasRootConfigControlObligation(root)) {
        return `gateway ${gatewayId} has an unfinished release roll and config obligation`;
    }
    if (root.desiredRelease !== root.liveRelease) {
        return `gateway ${gatewayId} desired release is not converged to live`;
    }
    const inspection = inspectRetirementState(gatewayId, root, revisions, now);
    if (inspection.error)
        return inspection.error;
    if (!sameRuntimeIdentity(claim.liveRuntimeIdentity, inspection.liveRuntimeIdentity)) {
        return `gateway ${gatewayId} live runtime identity changed after retirement claim`;
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
        const revisionsSnap = await transaction.get(input.db.collection(GLM_GATEWAYS_COLLECTION).where("gateway", "==", input.gatewayId));
        const stateError = rootData.desiredStatus !== "retired"
            ? `gateway ${input.gatewayId} desiredStatus is no longer retired`
            : rejectionForCurrentState(input.gatewayId, root, claim, revisionsSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() })), input.now);
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
