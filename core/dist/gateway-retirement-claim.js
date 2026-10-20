import { GATEWAY_HEARTBEAT_INTERVAL_MS, GATEWAY_UNREACHABLE_AFTER_MS, GATEWAYS_COLLECTION, } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION, } from "@octogee/shared/types/glm";
import { customerRuntimeMutationFenced, isGatewayRuntimeDoc, projectGatewayDesiredRootForGateway, } from "@octogee/shared/types/gateway-releases";
import { findActiveGatewayMigration } from "./fleet-operation-lock.js";
// Retirement under the simple-roll model (GATEWAY-SIMPLE-ROLL-SPEC): claim the
// gateway atomically (guarding mounted customers + in-flight migrations), flip
// desiredStatus to retired, and let the reconciler tear the realization down.
// Durable config lives in Gitea the whole time — nothing is captured at
// retirement, so there is no wake phase and no config checkpoint ceremony.
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
function retirementHeartbeat(value) {
    if (!isPlainRecord(value) ||
        !Array.isArray(value.mountedCustomers) ||
        !value.mountedCustomers.every((customer) => typeof customer === "string" && customer.length > 0)) {
        return null;
    }
    return {
        heartbeat: value,
        mountedCustomers: value.mountedCustomers,
    };
}
function liveRuntimeIdentity(heartbeat) {
    if (typeof heartbeat.startedAt !== "number" ||
        !Number.isFinite(heartbeat.startedAt) ||
        !nonEmptyString(heartbeat.version) ||
        !nonEmptyString(heartbeat.openclawVersion)) {
        return null;
    }
    return {
        startedAt: heartbeat.startedAt,
        version: heartbeat.version,
        openclawVersion: heartbeat.openclawVersion,
    };
}
// A RUNNING gateway may retire only on fresh telemetry proving zero mounted
// customers. A PAUSED gateway (replicas 0) has no pod, no mounts, and nothing
// unflushed (the watcher + preStop flush committed durable config at pause) —
// it retires directly, with no wake.
function runningRetirementError(gatewayId, runtime, now, expectedRelease, telemetryObservedAfter) {
    if (!isGatewayRuntimeDoc(runtime) || runtime.gatewayId !== gatewayId) {
        return {
            error: `gateway ${gatewayId} runtime telemetry is unavailable`,
            liveRuntimeIdentity: null,
        };
    }
    if (runtime.release !== expectedRelease) {
        return {
            error: `gateway ${gatewayId} runtime release ${runtime.release} does not match live release ${expectedRelease}`,
            liveRuntimeIdentity: null,
        };
    }
    const telemetry = retirementHeartbeat(runtime.heartbeat);
    if (!telemetry) {
        return {
            error: `gateway ${gatewayId} mount telemetry is unavailable`,
            liveRuntimeIdentity: null,
        };
    }
    if (telemetry.mountedCustomers.length > 0) {
        return {
            error: `gateway ${gatewayId} still has mounted customers: ${telemetry.mountedCustomers.join(", ")}`,
            liveRuntimeIdentity: null,
        };
    }
    const { heartbeat } = telemetry;
    if (!freshObservation(heartbeat.lastHeartbeatAt, now)) {
        return {
            error: `gateway ${gatewayId} telemetry is stale or unavailable`,
            liveRuntimeIdentity: null,
        };
    }
    const observedAt = millis(heartbeat.lastHeartbeatAt);
    if (telemetryObservedAfter !== undefined &&
        observedAt <= telemetryObservedAfter) {
        return {
            error: `gateway ${gatewayId} telemetry predates retirement fence`,
            liveRuntimeIdentity: null,
        };
    }
    return { error: null, liveRuntimeIdentity: liveRuntimeIdentity(heartbeat) };
}
function readClaim(value) {
    if (!isPlainRecord(value))
        return null;
    const valid = [
        typeof value.operationId === "string",
        Number.isInteger(value.version),
        value.version > 0,
        typeof value.claimedAt === "number",
        Number.isFinite(value.claimedAt),
        value.previousDesiredStatus === "running" || value.previousDesiredStatus === "draining" || value.previousDesiredStatus === "paused",
        value.phase === "claimed",
    ].every(Boolean);
    if (!valid)
        return null;
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
function claimableGatewayRetirementRoot(gatewayId, value) {
    const projected = projectGatewayDesiredRootForGateway(value, gatewayId);
    if (projected === null) {
        throw new GatewayRetirementConflictError(`gateway ${gatewayId} durable root is unavailable`);
    }
    const root = projected;
    if (projected.desiredStatus === "retired") {
        throw new GatewayRetirementConflictError(`gateway ${gatewayId} is already retired`);
    }
    if (root.retirementClaim != null) {
        throw new GatewayRetirementConflictError(`gateway ${gatewayId} already has a retirement claim`);
    }
    if (projected.desiredStatus !== "paused" &&
        projected.liveRelease != null &&
        projected.desiredRelease !== projected.liveRelease) {
        throw new GatewayRetirementConflictError(`gateway ${gatewayId} desired release is not converged to live`);
    }
    return {
        rootData: projected,
        root,
    };
}
export async function assertGatewayRuntimeMutationUnfenced(db, transaction, gatewayId) {
    const root = await transaction.get(db.collection(GATEWAYS_COLLECTION).doc(gatewayId));
    if (root.data()?.runtimeRestartFence !== undefined) {
        throw new GatewayRetirementConflictError(`gateway ${gatewayId} runtime restart outcome is unresolved`);
    }
    const [retainedTransfers, transferTargets, mirroredUsers] = await Promise.all([
        transaction.get(db.collection("users")
            .where("provisioning.openclaw.sourceTransferFence.sourceGatewayId", "==", gatewayId)),
        transaction.get(db.collection("users")
            .where("provisioning.openclaw.sourceTransferFence.targetGatewayId", "==", gatewayId)),
        transaction.get(db.collection("users")
            .where("provisioning.openclaw.gatewayId", "==", gatewayId)),
    ]);
    if (retainedTransfers.size > 0 || transferTargets.size > 0 || mirroredUsers.docs.some(doc => customerRuntimeMutationFenced(doc.data()))) {
        throw new GatewayRetirementConflictError(`gateway ${gatewayId} source transfer outcome is unresolved`);
    }
}
export async function claimGatewayRetirementAtomic(input) {
    const rootRef = input.db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
    const operationRef = input.db
        .collection(GLM_OPERATIONS_COLLECTION)
        .doc(input.operationId);
    return input.db.runTransaction(async (transaction) => {
        const [rootSnap, activeOperations] = await Promise.all([
            transaction.get(rootRef),
            transaction.get(input.db
                .collection(GLM_OPERATIONS_COLLECTION)
                .where("status", "in", ["pending", "running"])),
        ]);
        const { rootData } = claimableGatewayRetirementRoot(input.gatewayId, rootSnap.exists ? rootSnap.data() : undefined);
        const migrationConflict = findActiveGatewayMigration(input.gatewayId, activeOperations.docs.map((doc) => {
            const operation = doc.data();
            return {
                id: doc.id,
                kind: typeof operation.kind === "string" ? operation.kind : "",
                status: typeof operation.status === "string" ? operation.status : "",
                input: operation.input,
                customerMigrationV2: operation.customerMigrationV2,
            };
        }));
        if (migrationConflict) {
            throw new GatewayRetirementConflictError(`customer migration is in flight for gateway ${input.gatewayId}`);
        }
        await assertGatewayRuntimeMutationUnfenced(input.db, transaction, input.gatewayId);
        let liveRuntimeIdentity = null;
        if (rootData.desiredStatus !== "paused" && rootData.liveRelease != null) {
            const runtimeSnap = await transaction.get(input.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.gatewayId));
            const inspection = runningRetirementError(input.gatewayId, runtimeSnap.exists ? runtimeSnap.data() : undefined, input.now, rootData.liveRelease, input.telemetryObservedAfter);
            if (inspection.error)
                throw new GatewayRetirementConflictError(inspection.error);
            liveRuntimeIdentity = inspection.liveRuntimeIdentity;
        }
        await input.claimGuard?.({ transaction, root: rootData });
        const version = nextRetirementVersion(rootData.retirementVersion);
        const claim = {
            operationId: input.operationId,
            version,
            claimedAt: input.now,
            phase: "claimed",
            liveRelease: rootData.liveRelease,
            liveRuntimeIdentity,
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
function matchingRetirementClaim(root, operationId, version) {
    const claim = readClaim(root.retirementClaim);
    return claim?.operationId === operationId && claim.version === version ? claim : null;
}
export async function verifyGatewayRetirementClaimAtomic(input) {
    const rootRef = input.db.collection(GATEWAYS_COLLECTION).doc(input.gatewayId);
    return input.db.runTransaction(async (transaction) => {
        const rootSnap = await transaction.get(rootRef);
        const root = rootSnap.exists ? rootSnap.data() : undefined;
        if (!isPlainRecord(root)) {
            return { ok: false, error: `gateway ${input.gatewayId} durable root is unavailable` };
        }
        const claim = matchingRetirementClaim(root, input.operationId, input.version);
        if (!claim) {
            return {
                ok: false,
                error: `gateway ${input.gatewayId} retirement claim does not match this operation`,
            };
        }
        if (root.desiredStatus !== "retired") {
            return {
                ok: false,
                error: `gateway ${input.gatewayId} desiredStatus left retired during retirement`,
            };
        }
        try {
            await assertGatewayRuntimeMutationUnfenced(input.db, transaction, input.gatewayId);
        }
        catch (error) {
            if (!(error instanceof GatewayRetirementConflictError))
                throw error;
            return { ok: false, error: error.message };
        }
        return { ok: true };
    });
}
