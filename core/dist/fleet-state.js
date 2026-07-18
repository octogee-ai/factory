import { GATEWAYS_COLLECTION, } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION, resolveUserGatewayShellState, } from "@octogee/shared/types/glm";
import { GATEWAY_ASSIGNMENTS_SUBCOLLECTION, } from "@octogee/shared/types/gateway-releases";
import { customerMigrationV2GatewayRootFenceEqual, customerMigrationV2GatewayRootFenceMatches, } from "./customer-migration-v2.js";
export async function writeGatewayHeartbeat(deps, snapshot) {
    if (!snapshot.gatewayId) {
        throw new Error("gatewayId is required for a gateway heartbeat");
    }
    const heartbeat = {
        status: snapshot.status,
        version: snapshot.version,
        openclawVersion: snapshot.openclawVersion,
        mountedCustomers: snapshot.mountedCustomers,
        internalUrl: snapshot.internalUrl,
        startedAt: snapshot.startedAt,
        lastHeartbeatAt: deps.serverTimestamp(),
    };
    await deps.db
        .collection(GLM_GATEWAYS_COLLECTION)
        .doc(snapshot.gatewayId)
        .set({ heartbeat }, { merge: true });
}
function recordOrEmpty(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return value;
}
function customerMigrationV2FenceIsExact(operation, fence) {
    const state = recordOrEmpty(operation?.customerMigrationV2);
    const sourceRootFence = state.sourceRootFence;
    const targetRootFence = state.targetRootFence;
    return [
        operation?.status === "running",
        state.phase === "targetVerified",
        state.operationId === fence.operationId,
        state.migrationId === fence.migrationId,
        state.uid === fence.uid,
        state.slug === fence.slug,
        state.sourceGatewayId === fence.sourceGatewayId,
        state.sourceEpoch === fence.sourceEpoch,
        state.sourceRelease === fence.sourceRelease,
        state.sourceAssignmentMode === fence.sourceAssignmentMode,
        customerMigrationV2GatewayRootFenceEqual(sourceRootFence, fence.sourceRootFence),
        state.targetGatewayId === fence.targetGatewayId,
        state.targetRelease === fence.targetRelease,
        customerMigrationV2GatewayRootFenceEqual(targetRootFence, fence.targetRootFence),
    ].every(Boolean);
}
// Atomic cutover (GATEWAY-RELEASES-SPEC, PR5 review P0). The mirror move AND the
// assignment write commit in ONE Firestore transaction, so a crash/throw leaves
// NEITHER — never a half-state where the mirror points at the target while the
// assignment still says source. Cross-gateway also drops the stale source
// assignment in the same transaction.
//
// The commit is also the ROSTER FLIP: the written assignment is stamped
// state:"serving" and its epoch is bumped past the customer's prior assignment —
// the per-customer monotonic epoch the edge's forwarding rides.
export async function commitCutoverAtomic(deps, params) {
    const nowMs = deps.now ? deps.now().getTime() : Date.now();
    await deps.db.runTransaction(async (txn) => {
        const prior = await readPriorAssignment(txn, deps.db, params);
        const targetRootSnap = await txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.toGatewayId));
        const targetRoot = targetRootSnap.exists ? targetRootSnap.data() : undefined;
        assertTargetAcceptsCutover(targetRoot, params.toGatewayId);
        if (params.customerMigrationV2Fence) {
            const alreadyCommitted = await assertCustomerMigrationV2FenceCurrent({
                txn,
                db: deps.db,
                params,
                targetRoot,
                prior,
            });
            if (alreadyCommitted)
                return;
        }
        updateUserMirror(txn, deps, params, targetRoot);
        updateAssignment(txn, deps.db, params, prior.epoch, nowMs);
    });
}
async function readPriorAssignment(txn, db, params) {
    if (!params.assignment) {
        return { exists: false, data: undefined, epoch: 0 };
    }
    const snapshot = await txn.get(assignmentRef(db, params.fromGatewayId, params.uid));
    const data = snapshot.exists ? snapshot.data() : undefined;
    const epoch = data?.epoch;
    return {
        exists: snapshot.exists,
        data,
        epoch: typeof epoch === "number" && epoch >= 0 ? epoch : 0,
    };
}
function assertTargetAcceptsCutover(targetRoot, gatewayId) {
    if (targetRoot?.desiredStatus === "retired" || targetRoot?.retirementClaim != null) {
        throw new Error(`gateway ${gatewayId} has a current retirement claim`);
    }
}
async function assertCustomerMigrationV2FenceCurrent(input) {
    const { txn, db, params, targetRoot, prior } = input;
    const fence = params.customerMigrationV2Fence;
    assertCustomerMigrationV2ParametersExact(params, fence);
    const [operationSnap, targetAssignmentSnap, sourceRootSnap] = await Promise.all([
        txn.get(db.collection(GLM_OPERATIONS_COLLECTION).doc(fence.operationId)),
        txn.get(assignmentRef(db, params.toGatewayId, params.uid)),
        txn.get(db.collection(GATEWAYS_COLLECTION).doc(fence.sourceGatewayId)),
    ]);
    assertCustomerMigrationV2ProofsExact({
        fence,
        operation: operationSnap.exists ? operationSnap.data() : undefined,
        targetRoot,
        sourceRoot: sourceRootSnap.exists ? sourceRootSnap.data() : undefined,
    });
    const targetAssignment = targetAssignmentSnap.exists ? targetAssignmentSnap.data() : undefined;
    if (customerMigrationAlreadyCommitted(prior, targetAssignment, fence))
        return true;
    assertCustomerMigrationSourceAssignmentExact(prior, fence);
    return false;
}
function assertCustomerMigrationV2ParametersExact(params, fence) {
    const parametersExact = [
        fence.uid === params.uid,
        fence.slug === params.slug,
        fence.sourceGatewayId === params.fromGatewayId,
        fence.targetGatewayId === params.toGatewayId,
        params.assignment !== null,
    ].every(Boolean);
    if (!parametersExact) {
        throw new Error("customer migration V2 cutover parameters changed after verification");
    }
}
function assertCustomerMigrationV2ProofsExact(input) {
    const { fence, operation, targetRoot, sourceRoot } = input;
    if (!customerMigrationV2FenceIsExact(operation, fence)) {
        throw new Error("customer migration V2 is not durably target-verified at cutover");
    }
    if (!customerMigrationV2GatewayRootFenceMatches(targetRoot, fence.targetRootFence)) {
        throw new Error("customer migration V2 target root changed before cutover");
    }
    if (!customerMigrationV2GatewayRootFenceMatches(sourceRoot, fence.sourceRootFence)) {
        throw new Error("customer migration V2 source root changed before cutover");
    }
}
function customerMigrationAlreadyCommitted(prior, targetAssignment, fence) {
    return !prior.exists &&
        targetAssignment?.gatewayId === fence.targetGatewayId &&
        targetAssignment.updatedByOperationId === fence.operationId &&
        targetAssignment.state === "serving";
}
function assertCustomerMigrationSourceAssignmentExact(prior, fence) {
    const sourceAssignmentExact = [
        prior.epoch === fence.sourceEpoch,
        prior.data?.uid === fence.uid,
        prior.data?.slug === fence.slug,
        prior.data?.gatewayId === fence.sourceGatewayId,
        prior.data?.state === "quiescing",
        prior.data?.updatedByOperationId === fence.operationId,
    ].every(Boolean);
    if (!sourceAssignmentExact) {
        throw new Error("customer migration V2 source assignment changed before cutover");
    }
}
function updateUserMirror(txn, deps, params, targetRoot) {
    if (!params.flipMirror)
        return;
    const shellState = resolveUserGatewayShellState(targetRoot, params.uid);
    txn.update(deps.db.collection("users").doc(params.uid), {
        "provisioning.openclaw.gatewayId": params.toGatewayId,
        "provisioning.openclaw.gatewayAssignedAt": deps.serverTimestamp(),
        "provisioning.openclaw.gatewayProfile": shellState.gatewayProfile,
        "provisioning.openclaw.shellsEnabled": shellState.shellsEnabled,
    });
}
function updateAssignment(txn, db, params, priorEpoch, nowMs) {
    if (!params.assignment)
        return;
    txn.set(assignmentRef(db, params.toGatewayId, params.uid), {
        uid: params.uid,
        slug: params.slug,
        gatewayId: params.toGatewayId,
        source: params.assignment.source,
        state: "serving",
        epoch: priorEpoch + 1,
        updatedAt: nowMs,
        updatedByOperationId: params.assignment.updatedByOperationId,
    });
    if (params.fromGatewayId !== params.toGatewayId) {
        txn.delete(assignmentRef(db, params.fromGatewayId, params.uid));
    }
}
// Flip ONLY the roster state on an existing assignment — epoch stays put. The
// gated quiesce writes "quiescing" here BEFORE the source pod is quiesced
// (blocking source serving ahead of the target ever serving — no double-serve
// window); a pre-cutover rollback writes "serving" to restore the source. No-op
// when the customer has no assignment doc (legacy migration): there is no
// roster entry for the edge to consult, so nothing to gate.
export async function markAssignmentState(deps, params) {
    await deps.db.runTransaction(async (txn) => {
        const ref = assignmentRef(deps.db, params.gatewayId, params.uid);
        const snap = await txn.get(ref);
        if (!snap.exists) {
            if (!params.createIfMissing)
                return;
            createMissingAssignment(txn, ref, deps, params);
            return;
        }
        const assignment = snap.data();
        assertAssignmentStateUpdateMatches(assignment, params);
        txn.update(ref, {
            state: params.state,
            ...(params.updatedByOperationId
                ? {
                    updatedAt: deps.now ? deps.now().getTime() : Date.now(),
                    updatedByOperationId: params.updatedByOperationId,
                }
                : {}),
        });
    });
}
function createMissingAssignment(txn, ref, deps, params) {
    const exactBinding = [
        params.state === "quiescing",
        params.slug,
        typeof params.epoch === "number",
        params.updatedByOperationId,
    ].every(Boolean);
    if (!exactBinding) {
        throw new Error("unassigned source quiesce requires an exact operation binding");
    }
    txn.set(ref, {
        uid: params.uid,
        slug: params.slug,
        gatewayId: params.gatewayId,
        source: "migrate-customer",
        state: params.state,
        epoch: params.epoch,
        updatedAt: deps.now ? deps.now().getTime() : Date.now(),
        updatedByOperationId: params.updatedByOperationId,
    });
}
function assertAssignmentStateUpdateMatches(assignment, params) {
    const current = assignment ?? {};
    const currentOwner = typeof current.updatedByOperationId === "string"
        ? current.updatedByOperationId
        : null;
    const exact = [
        params.slug === undefined || current.slug === params.slug,
        params.epoch === undefined || current.epoch === params.epoch,
        current.gatewayId === undefined || current.gatewayId === params.gatewayId,
        current.uid === undefined || current.uid === params.uid,
        !params.createIfMissing || current.updatedByOperationId === params.updatedByOperationId,
        params.expected === undefined || (current.state === params.expected.state &&
            currentOwner === params.expected.updatedByOperationId),
    ].every(Boolean);
    if (!exact)
        throw new Error("source assignment changed before roster state update");
}
function assignmentRef(db, gatewayId, uid) {
    const gatewayDoc = db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
    if (!gatewayDoc.collection) {
        throw new Error("FleetStateFirestore doc ref does not support subcollections");
    }
    return gatewayDoc.collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(uid);
}
