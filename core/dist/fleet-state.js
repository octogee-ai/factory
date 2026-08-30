import { GATEWAYS_COLLECTION, } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION, isOperatorManaged, resolveUserGatewayControlState, } from "@octogee/shared/types/glm";
import { GATEWAY_ASSIGNMENTS_SUBCOLLECTION, hasFreshReadyKubernetesObservation, isGatewayRuntimeDoc, projectGatewayDesiredRootForGateway, } from "@octogee/shared/types/gateway-releases";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { resolveBuilderTier } from "@octogee/shared/types/billing";
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
    const stateStrategy = state.strategy ?? "migrate-state";
    const cutoverReady = fence.strategy === "provision-fresh"
        ? state.phase === "freshCutoverReady"
        : state.phase === "targetVerified";
    return [
        operation?.status === "running",
        cutoverReady,
        stateStrategy === fence.strategy,
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
        const targetRootRef = deps.db.collection(GATEWAYS_COLLECTION).doc(params.toGatewayId);
        const targetRootSnap = await txn.get(targetRootRef);
        const targetRoot = targetRootSnap.exists ? targetRootSnap.data() : undefined;
        if (params.automatic) {
            const [sourceRootSnap, userSnap] = await Promise.all([
                txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.fromGatewayId)),
                txn.get(deps.db.collection("users").doc(params.uid)),
            ]);
            assertAutomaticCutoverOwnership({
                uid: params.uid,
                fromGatewayId: params.fromGatewayId,
                toGatewayId: params.toGatewayId,
                sourceRoot: sourceRootSnap.exists ? sourceRootSnap.data() : undefined,
                targetRoot,
                user: userSnap.exists ? userSnap.data() : undefined,
            });
        }
        assertTargetAcceptsCutover(targetRoot, params.toGatewayId);
        if (params.customerMigrationV2Fence) {
            const alreadyCommitted = await assertCustomerMigrationV2FenceCurrent({
                txn,
                db: deps.db,
                params,
                targetRoot,
                prior,
                nowMs,
            });
            if (alreadyCommitted)
                return;
        }
        updateUserMirror(txn, deps, params, targetRoot);
        updateAssignment(txn, deps.db, params, prior.epoch, nowMs);
    });
}
function assertAutomaticCutoverOwnership(input) {
    if (isOperatorManaged(input.sourceRoot?.managedBy)) {
        throw new Error(`automatic cutover fenced: gateway ${input.fromGatewayId} is operator-managed`);
    }
    if (isOperatorManaged(input.targetRoot?.managedBy)) {
        throw new Error(`automatic cutover fenced: gateway ${input.toGatewayId} is operator-managed`);
    }
    const provisioning = recordOrEmpty(input.user?.provisioning);
    const openclaw = recordOrEmpty(provisioning.openclaw);
    if (isOperatorManaged(openclaw.managedBy)) {
        throw new Error(`automatic cutover fenced: builder ${input.uid} is operator-managed`);
    }
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
    const { txn, db, params, targetRoot, prior, nowMs } = input;
    const fence = params.customerMigrationV2Fence;
    assertCustomerMigrationV2ParametersExact(params, fence);
    const [operationSnap, targetAssignmentSnap, sourceRootSnap, userSnap] = await Promise.all([
        txn.get(db.collection(GLM_OPERATIONS_COLLECTION).doc(fence.operationId)),
        txn.get(assignmentRef(db, params.toGatewayId, params.uid)),
        txn.get(db.collection(GATEWAYS_COLLECTION).doc(fence.sourceGatewayId)),
        txn.get(db.collection("users").doc(params.uid)),
    ]);
    const operation = operationSnap.exists ? operationSnap.data() : undefined;
    assertCustomerMigrationV2ProofsExact({
        fence,
        operation,
        targetRoot,
        sourceRoot: sourceRootSnap.exists ? sourceRootSnap.data() : undefined,
    });
    const targetAssignment = targetAssignmentSnap.exists ? targetAssignmentSnap.data() : undefined;
    if (customerMigrationAlreadyCommitted(prior, targetAssignment, fence))
        return true;
    assertBuilderActivationCutoverAuthorized({
        operation,
        user: userSnap.exists ? userSnap.data() : undefined,
        targetRoot,
        fence,
        nowMs,
    });
    assertCustomerMigrationSourceAssignmentExact(prior, fence);
    return false;
}
function assertBuilderActivationCutoverAuthorized(input) {
    const operationInput = recordOrEmpty(input.operation?.input);
    const allocation = recordOrEmpty(input.targetRoot?.allocation);
    if (operationInput.source !== "builder-activation-lease" ||
        allocation.kind !== "disposable-builder")
        return;
    const user = input.user;
    const provisioning = recordOrEmpty(user?.provisioning);
    const openclaw = recordOrEmpty(provisioning.openclaw);
    const lease = recordOrEmpty(openclaw.activationLease);
    const authorized = [
        accountAllowsInteractiveAccess(user),
        resolveBuilderTier(user ?? {}, new Date(input.nowMs)) !== null,
        lease.status === "activating",
        lease.targetGatewayId === input.fence.targetGatewayId,
        typeof lease.leaseId === "string" && lease.leaseId.length > 0,
        Number.isSafeInteger(lease.generation) && lease.generation > 0,
        allocation.kind === "disposable-builder",
        allocation.claimedByUid === input.fence.uid,
        allocation.leaseId === lease.leaseId,
        allocation.generation === lease.generation,
    ].every(Boolean);
    if (!authorized) {
        throw new Error("Builder activation authorization changed before cutover");
    }
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
        throw new Error("customer migration V2 is not durably cutover-ready");
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
    const controlState = resolveUserGatewayControlState(targetRoot, params.uid);
    txn.update(deps.db.collection("users").doc(params.uid), {
        "provisioning.openclaw.gatewayId": params.toGatewayId,
        "provisioning.openclaw.gatewayAssignedAt": deps.serverTimestamp(),
        "provisioning.openclaw.gatewayProfile": controlState.gatewayProfile,
        "provisioning.openclaw.controlUiEnabled": controlState.controlUiEnabled,
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
function millisFromUnknown(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (value instanceof Date)
        return value.getTime();
    if (value &&
        typeof value === "object" &&
        typeof value.toMillis === "function") {
        const result = value.toMillis();
        return typeof result === "number" && Number.isFinite(result) ? result : null;
    }
    return null;
}
function recoveryOperationMatches(operation, params) {
    const input = recordOrEmpty(operation?.input);
    const recordedLease = input.disposableLease === null
        ? null
        : recordOrEmpty(input.disposableLease);
    const leaseMatches = params.disposableLease
        ? recordedLease !== null &&
            recordedLease.leaseId === params.disposableLease.leaseId &&
            recordedLease.generation === params.disposableLease.generation
        : recordedLease === null;
    const operationMatches = [
        operation?.kind === "migrate-customer",
        operation?.status === "succeeded",
        operation?.origin === "automatic",
        operation?.createdBy === "glm-controller-placement-policy",
        operation?.gatewayId === params.toGatewayId,
        operation?.inputUid === params.uid,
        input.uid === params.uid,
        input.slug === params.slug,
        input.recoveryKind === params.kind,
        input.fromGatewayId === params.fromGatewayId,
        input.toGatewayId === params.toGatewayId,
        input.sourceEpoch === params.expectedSourceEpoch,
    ].every(Boolean);
    return leaseMatches && operationMatches;
}
function recoveryAlreadyCommitted(input) {
    const openclaw = recordOrEmpty(recordOrEmpty(input.user?.provisioning).openclaw);
    const targetRoot = projectGatewayDesiredRootForGateway(input.targetRootData, input.params.toGatewayId);
    const controlState = resolveUserGatewayControlState(targetRoot
        ? { ...targetRoot, builderAccess: targetRoot.builderAccess ?? undefined }
        : undefined, input.params.uid);
    const targetAssignmentExact = [
        input.targetAssignment?.uid === input.params.uid,
        input.targetAssignment?.slug === input.params.slug,
        input.targetAssignment?.gatewayId === input.params.toGatewayId,
        input.targetAssignment?.source === "repair",
        input.targetAssignment?.state === "serving",
        input.targetAssignment?.epoch === input.params.expectedSourceEpoch + 1,
        input.targetAssignment?.updatedByOperationId === input.params.operationId,
    ].every(Boolean);
    const operationAt = millisFromUnknown(input.operation?.completedAt);
    const operationTimingExact = [
        operationAt !== null,
        input.operation?.createdAt === operationAt,
        input.operation?.startedAt === operationAt,
        input.targetAssignment?.updatedAt === operationAt,
    ].every(Boolean);
    const disposableLeaseExact = returningLeaseMatches(openclaw, input.params, operationAt);
    return [
        recoveryOperationMatches(input.operation, input.params),
        !input.sourceAssignmentExists,
        openclaw.gatewayId === input.params.toGatewayId,
        millisFromUnknown(openclaw.gatewayAssignedAt) === operationAt,
        openclaw.gatewayProfile === controlState.gatewayProfile,
        openclaw.controlUiEnabled === controlState.controlUiEnabled,
        targetAssignmentExact,
        operationTimingExact,
        disposableLeaseExact,
        runtimeResetMatches(openclaw, input.params, operationAt),
    ].every(Boolean);
}
function returningLeaseMatches(openclaw, params, operationAt) {
    if (!params.disposableLease)
        return true;
    const lease = recordOrEmpty(openclaw.activationLease);
    return [
        lease.leaseId === params.disposableLease.leaseId,
        lease.generation === params.disposableLease.generation,
        lease.status === "returning",
        lease.targetGatewayId === params.fromGatewayId,
        lease.returnReason === "source-unavailable",
        lease.returnOperationId === params.operationId,
        lease.returningAt === operationAt,
    ].every(Boolean);
}
function disposableRuntimeReset(params, requestedAt) {
    if (params.kind !== "recover-disposable-customer" || !params.disposableLease)
        return null;
    return {
        status: "pending",
        uid: params.uid,
        slug: params.slug,
        operationId: params.operationId,
        sourceGatewayId: params.fromGatewayId,
        targetGatewayId: params.toGatewayId,
        generation: params.expectedSourceEpoch + 1,
        disposableLeaseId: params.disposableLease.leaseId,
        disposableLeaseGeneration: params.disposableLease.generation,
        requestedAt,
    };
}
function runtimeResetMatches(openclaw, params, operationAt) {
    const expected = operationAt === null ? null : disposableRuntimeReset(params, operationAt);
    if (expected === null)
        return openclaw.runtimeReset === undefined;
    const actual = recordOrEmpty(openclaw.runtimeReset);
    return Object.entries(expected).every(([key, value]) => actual[key] === value);
}
function recoveryTargetRootReady(root, params) {
    if (root === null)
        return false;
    return [
        params.sharedGatewayIds.includes(params.toGatewayId),
        root.gatewayClass === "shared",
        root.desiredStatus === "running",
        root.liveRelease !== null,
        root.desiredRelease === root.liveRelease,
        !isOperatorManaged(root.managedBy),
    ].every(Boolean);
}
function recoveryTargetRuntimeReady(runtime, root, params, nowMs) {
    if (runtime === null)
        return false;
    const heartbeatAt = millisFromUnknown(runtime.heartbeat.lastHeartbeatAt);
    const heartbeatFresh = heartbeatAt === null
        ? false
        : nowMs - heartbeatAt <= params.targetHeartbeatMaxAgeMs;
    return [
        runtime.gatewayId === params.toGatewayId,
        runtime.release === root.liveRelease,
        runtime.lifecycle === "serving",
        runtime.heartbeat.status === "ready",
        heartbeatFresh,
        hasFreshReadyKubernetesObservation(runtime, nowMs, params.targetHeartbeatMaxAgeMs),
    ].every(Boolean);
}
function assertRecoveryTargetReady(input) {
    const { params, targetRootData, targetRuntimeData, nowMs } = input;
    const root = projectGatewayDesiredRootForGateway(targetRootData, params.toGatewayId);
    const runtime = isGatewayRuntimeDoc(targetRuntimeData) ? targetRuntimeData : null;
    if (!recoveryTargetRootReady(root, params) ||
        !recoveryTargetRuntimeReady(runtime, root, params, nowMs)) {
        throw new Error(`recovery target runtime is not freshly ready: ${params.toGatewayId}`);
    }
}
function assertRecoverySourceIdentity(root, openclaw, sourceAssignment, params) {
    if (!root || !sourceAssignment) {
        throw new Error("unavailable gateway recovery source changed before cutover");
    }
    const exact = [
        !isOperatorManaged(root.managedBy),
        !isOperatorManaged(openclaw.managedBy),
        openclaw.gatewayId === params.fromGatewayId,
        sourceAssignment.uid === params.uid,
        sourceAssignment.slug === params.slug,
        sourceAssignment.gatewayId === params.fromGatewayId,
        sourceAssignment.state === "serving",
        sourceAssignment.epoch === params.expectedSourceEpoch,
    ].every(Boolean);
    if (!exact)
        throw new Error("unavailable gateway recovery source changed before cutover");
}
function assertSharedRecoverySource(root, params) {
    const invalid = [
        root.gatewayClass !== "shared",
        root.desiredStatus !== "running",
        !params.sharedGatewayIds.includes(params.fromGatewayId),
        params.disposableLease !== undefined,
    ].some(Boolean);
    if (invalid)
        throw new Error("shared gateway recovery source is not an active pool member");
}
function disposableRecoveryLease(root, openclaw, params) {
    if (!params.disposableLease) {
        throw new Error("disposable gateway recovery lease or allocation changed before cutover");
    }
    const lease = recordOrEmpty(openclaw.activationLease);
    const allocation = recordOrEmpty(root.allocation);
    const exact = [
        root.gatewayClass !== "shared",
        root.ownerUid === params.uid,
        allocation.kind === "disposable-builder",
        allocation.claimedByUid === params.uid,
        allocation.leaseId === params.disposableLease.leaseId,
        allocation.generation === params.disposableLease.generation,
        lease.leaseId === params.disposableLease.leaseId,
        lease.generation === params.disposableLease.generation,
        lease.status === "active",
        lease.targetGatewayId === params.fromGatewayId,
    ].every(Boolean);
    if (!exact) {
        throw new Error("disposable gateway recovery lease or allocation changed before cutover");
    }
    return lease;
}
function assertRecoverySource(input) {
    const { params, sourceRootData, user, sourceAssignment } = input;
    const root = projectGatewayDesiredRootForGateway(sourceRootData, params.fromGatewayId);
    const openclaw = recordOrEmpty(recordOrEmpty(user?.provisioning).openclaw);
    assertRecoverySourceIdentity(root, openclaw, sourceAssignment, params);
    if (params.kind === "recover-shared-customer") {
        assertSharedRecoverySource(root, params);
        return null;
    }
    return disposableRecoveryLease(root, openclaw, params);
}
function clearRecoveredSourceMount(input) {
    const runtimeData = input.sourceRuntimeSnapshot.exists
        ? input.sourceRuntimeSnapshot.data()
        : undefined;
    const runtime = isGatewayRuntimeDoc(runtimeData) ? runtimeData : null;
    if (!runtime?.heartbeat.mountedCustomers.includes(input.slug))
        return;
    input.txn.update(input.sourceRuntimeRef, {
        heartbeat: {
            ...runtime.heartbeat,
            mountedCustomers: runtime.heartbeat.mountedCustomers.filter((mountedCustomer) => mountedCustomer !== input.slug),
        },
    });
}
export async function commitUnavailableGatewayRecoveryAtomic(deps, params) {
    if (!params.operationId ||
        !Number.isSafeInteger(params.expectedSourceEpoch) ||
        params.expectedSourceEpoch < 0 ||
        params.fromGatewayId === params.toGatewayId) {
        throw new Error("unavailable gateway recovery parameters are invalid");
    }
    const operationRef = deps.db
        .collection(GLM_OPERATIONS_COLLECTION)
        .doc(params.operationId);
    const sourceAssignmentRef = assignmentRef(deps.db, params.fromGatewayId, params.uid);
    const targetAssignmentRef = assignmentRef(deps.db, params.toGatewayId, params.uid);
    const sourceRuntimeRef = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(params.fromGatewayId);
    const targetRuntimeRef = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(params.toGatewayId);
    const userRef = deps.db.collection("users").doc(params.uid);
    const nowMs = deps.now ? deps.now().getTime() : Date.now();
    await deps.db.runTransaction(async (txn) => {
        const [operationSnapshot, userSnapshot, sourceRootSnapshot, targetRootSnapshot, sourceRuntimeSnapshot, targetRuntimeSnapshot, sourceAssignmentSnapshot, targetAssignmentSnapshot,] = await Promise.all([
            txn.get(operationRef),
            txn.get(userRef),
            txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.fromGatewayId)),
            txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.toGatewayId)),
            txn.get(sourceRuntimeRef),
            txn.get(targetRuntimeRef),
            txn.get(sourceAssignmentRef),
            txn.get(targetAssignmentRef),
        ]);
        const operation = operationSnapshot.exists ? operationSnapshot.data() : undefined;
        const user = userSnapshot.exists ? userSnapshot.data() : undefined;
        const targetAssignment = targetAssignmentSnapshot.exists
            ? targetAssignmentSnapshot.data()
            : undefined;
        if (recoveryAlreadyCommitted({
            params,
            operation,
            user,
            targetRootData: targetRootSnapshot.exists ? targetRootSnapshot.data() : undefined,
            sourceAssignmentExists: sourceAssignmentSnapshot.exists,
            targetAssignment,
        })) {
            return;
        }
        if (operationSnapshot.exists) {
            throw new Error(`recovery operation ${params.operationId} conflicts with current authority`);
        }
        assertRecoveryTargetReady({
            params,
            targetRootData: targetRootSnapshot.exists ? targetRootSnapshot.data() : undefined,
            targetRuntimeData: targetRuntimeSnapshot.exists ? targetRuntimeSnapshot.data() : undefined,
            nowMs,
        });
        if (!params.validateTarget) {
            throw new Error("unavailable gateway recovery requires an atomic target admission fence");
        }
        await params.validateTarget({
            txn,
            targetGatewayId: params.toGatewayId,
            targetRoot: targetRootSnapshot.data(),
            targetRuntime: targetRuntimeSnapshot.data(),
        });
        const lease = assertRecoverySource({
            params,
            sourceRootData: sourceRootSnapshot.exists ? sourceRootSnapshot.data() : undefined,
            user,
            sourceAssignment: sourceAssignmentSnapshot.exists
                ? sourceAssignmentSnapshot.data()
                : undefined,
        });
        const targetRoot = targetRootSnapshot.data();
        const controlState = resolveUserGatewayControlState(targetRoot, params.uid);
        clearRecoveredSourceMount({
            txn,
            sourceRuntimeRef,
            sourceRuntimeSnapshot,
            slug: params.slug,
        });
        txn.update(userRef, {
            "provisioning.openclaw.gatewayId": params.toGatewayId,
            "provisioning.openclaw.gatewayAssignedAt": nowMs,
            "provisioning.openclaw.gatewayProfile": controlState.gatewayProfile,
            "provisioning.openclaw.controlUiEnabled": controlState.controlUiEnabled,
            ...(disposableRuntimeReset(params, nowMs)
                ? { "provisioning.openclaw.runtimeReset": disposableRuntimeReset(params, nowMs) }
                : {}),
            ...(lease
                ? {
                    "provisioning.openclaw.activationLease": {
                        ...lease,
                        status: "returning",
                        returnReason: "source-unavailable",
                        returnOperationId: params.operationId,
                        returningAt: nowMs,
                    },
                }
                : {}),
        });
        txn.set(targetAssignmentRef, {
            uid: params.uid,
            slug: params.slug,
            gatewayId: params.toGatewayId,
            source: "repair",
            state: "serving",
            epoch: params.expectedSourceEpoch + 1,
            updatedAt: nowMs,
            updatedByOperationId: params.operationId,
        });
        txn.delete(sourceAssignmentRef);
        txn.set(operationRef, {
            kind: "migrate-customer",
            status: "succeeded",
            origin: "automatic",
            createdBy: "glm-controller-placement-policy",
            createdAt: nowMs,
            startedAt: nowMs,
            completedAt: nowMs,
            input: {
                uid: params.uid,
                slug: params.slug,
                recoveryKind: params.kind,
                fromGatewayId: params.fromGatewayId,
                toGatewayId: params.toGatewayId,
                sourceEpoch: params.expectedSourceEpoch,
                disposableLease: params.disposableLease ?? null,
            },
            steps: [],
            gatewayId: params.toGatewayId,
            inputUid: params.uid,
        });
    });
    return { operationId: params.operationId };
}
function priorDisposableRecovery(input) {
    const { operation, params } = input;
    const priorInput = recordOrEmpty(operation?.input);
    const lease = recordOrEmpty(priorInput.disposableLease);
    const sourceGatewayId = typeof priorInput.fromGatewayId === "string"
        ? priorInput.fromGatewayId
        : "";
    const leaseId = typeof lease.leaseId === "string" ? lease.leaseId : "";
    const leaseGeneration = lease.generation;
    const exact = [
        operation?.kind === "migrate-customer",
        operation?.status === "succeeded",
        operation?.origin === "automatic",
        operation?.createdBy === "glm-controller-placement-policy",
        operation?.gatewayId === params.targetGatewayId,
        operation?.inputUid === params.uid,
        priorInput.uid === params.uid,
        priorInput.slug === params.slug,
        priorInput.recoveryKind === "recover-disposable-customer",
        priorInput.toGatewayId === params.targetGatewayId,
        priorInput.sourceEpoch === params.expectedAssignmentEpoch - 1,
        sourceGatewayId.length > 0,
        leaseId.length > 0,
        Number.isSafeInteger(leaseGeneration),
        leaseGeneration >= 0,
    ].every(Boolean);
    return exact
        ? { sourceGatewayId, leaseId, leaseGeneration: leaseGeneration }
        : null;
}
function recoveredRuntimeResetMarker(input) {
    return {
        status: "pending",
        uid: input.params.uid,
        slug: input.params.slug,
        operationId: input.params.operationId,
        sourceGatewayId: input.prior.sourceGatewayId,
        targetGatewayId: input.params.targetGatewayId,
        generation: input.params.expectedAssignmentEpoch + 1,
        disposableLeaseId: input.prior.leaseId,
        disposableLeaseGeneration: input.prior.leaseGeneration,
        requestedAt: input.requestedAt,
    };
}
function storedResetMatches(value, expected) {
    const actual = recordOrEmpty(value);
    if (actual.status !== "pending" && actual.status !== "acknowledged")
        return false;
    return Object.entries(expected)
        .filter(([key]) => key !== "status")
        .every(([key, expectedValue]) => actual[key] === expectedValue);
}
export async function commitRecoveredDisposableRuntimeResetAtomic(deps, params) {
    if (!params.operationId ||
        !params.previousRecoveryOperationId ||
        !params.sharedGatewayIds.includes(params.targetGatewayId) ||
        !Number.isSafeInteger(params.expectedAssignmentEpoch) ||
        params.expectedAssignmentEpoch < 1) {
        throw new Error("recovered disposable runtime reset parameters are invalid");
    }
    const nowMs = deps.now ? deps.now().getTime() : Date.now();
    const userRef = deps.db.collection("users").doc(params.uid);
    const targetRootRef = deps.db.collection(GATEWAYS_COLLECTION).doc(params.targetGatewayId);
    const targetRuntimeRef = deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(params.targetGatewayId);
    const assignment = assignmentRef(deps.db, params.targetGatewayId, params.uid);
    const previousOperation = deps.db
        .collection(GLM_OPERATIONS_COLLECTION)
        .doc(params.previousRecoveryOperationId);
    const operation = deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(params.operationId);
    await deps.db.runTransaction(async (txn) => {
        const [userSnapshot, targetRootSnapshot, targetRuntimeSnapshot, assignmentSnapshot, previousOperationSnapshot, operationSnapshot,] = await Promise.all([
            txn.get(userRef),
            txn.get(targetRootRef),
            txn.get(targetRuntimeRef),
            txn.get(assignment),
            txn.get(previousOperation),
            txn.get(operation),
        ]);
        const user = userSnapshot.data();
        const openclaw = recordOrEmpty(recordOrEmpty(user?.provisioning).openclaw);
        const targetRoot = projectGatewayDesiredRootForGateway(targetRootSnapshot.data(), params.targetGatewayId);
        const targetRuntimeData = targetRuntimeSnapshot.data();
        const targetRuntime = isGatewayRuntimeDoc(targetRuntimeData) ? targetRuntimeData : null;
        const prior = priorDisposableRecovery({
            operation: previousOperationSnapshot.data(),
            params,
        });
        if (!prior)
            throw new Error("previous disposable recovery fence changed");
        const marker = recoveredRuntimeResetMarker({ params, prior, requestedAt: nowMs });
        const assignmentData = assignmentSnapshot.data();
        if (operationSnapshot.exists) {
            const operationData = operationSnapshot.data();
            const operationInput = recordOrEmpty(operationData?.input);
            const replayExact = [
                operationData?.kind === "migrate-customer",
                operationData?.status === "succeeded",
                operationInput.recoveryKind === "recover-disposable-customer-runtime-reset",
                operationInput.previousRecoveryOperationId === params.previousRecoveryOperationId,
                assignmentData?.epoch === params.expectedAssignmentEpoch + 1,
                assignmentData?.updatedByOperationId === params.operationId,
                storedResetMatches(openclaw.runtimeReset, marker),
            ].every(Boolean);
            if (replayExact)
                return;
            throw new Error(`recovered runtime reset ${params.operationId} conflicts with current state`);
        }
        const heartbeatAt = millisFromUnknown(targetRuntime?.heartbeat.lastHeartbeatAt);
        const targetExact = [
            targetRoot?.gatewayClass === "shared",
            targetRoot?.desiredStatus === "running",
            targetRoot?.liveRelease !== null,
            targetRoot?.desiredRelease === targetRoot?.liveRelease,
            !isOperatorManaged(targetRoot?.managedBy),
            targetRuntime?.gatewayId === params.targetGatewayId,
            targetRuntime?.release === targetRoot?.liveRelease,
            targetRuntime?.lifecycle === "serving",
            heartbeatAt !== null,
            heartbeatAt !== null && nowMs - heartbeatAt <= params.targetHeartbeatMaxAgeMs,
            !targetRuntime?.heartbeat.mountedCustomers.includes(params.slug),
            openclaw.gatewayId === params.targetGatewayId,
            openclaw.runtimeReset === undefined,
            assignmentData?.uid === params.uid,
            assignmentData?.slug === params.slug,
            assignmentData?.gatewayId === params.targetGatewayId,
            assignmentData?.source === "repair",
            assignmentData?.state === "serving",
            assignmentData?.epoch === params.expectedAssignmentEpoch,
            assignmentData?.updatedByOperationId === params.previousRecoveryOperationId,
        ].every(Boolean);
        if (!targetExact)
            throw new Error("recovered disposable runtime reset fence changed");
        txn.update(userRef, { "provisioning.openclaw.runtimeReset": marker });
        txn.set(assignment, {
            ...assignmentData,
            epoch: params.expectedAssignmentEpoch + 1,
            updatedAt: nowMs,
            updatedByOperationId: params.operationId,
        });
        txn.set(operation, {
            kind: "migrate-customer",
            status: "succeeded",
            origin: "automatic",
            createdBy: "glm-controller-placement-policy",
            createdAt: nowMs,
            startedAt: nowMs,
            completedAt: nowMs,
            input: {
                uid: params.uid,
                slug: params.slug,
                recoveryKind: "recover-disposable-customer-runtime-reset",
                previousRecoveryOperationId: params.previousRecoveryOperationId,
                targetGatewayId: params.targetGatewayId,
                sourceEpoch: params.expectedAssignmentEpoch,
                disposableLease: {
                    leaseId: prior.leaseId,
                    generation: prior.leaseGeneration,
                },
            },
            steps: [],
            gatewayId: params.targetGatewayId,
            inputUid: params.uid,
        });
    });
    return { operationId: params.operationId };
}
// Flip ONLY the roster state on an existing assignment — epoch stays put. The
// gated quiesce writes "quiescing" here BEFORE the source pod is quiesced
// (blocking source serving ahead of the target ever serving — no double-serve
// window); a pre-cutover rollback writes "serving" to restore the source. No-op
// when the customer has no assignment doc (legacy migration): there is no
// roster entry for the edge to consult, so nothing to gate.
export async function markAssignmentState(deps, params) {
    await deps.db.runTransaction(async (txn) => {
        if (params.automatic) {
            const [rootSnap, userSnap] = await Promise.all([
                txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.gatewayId)),
                txn.get(deps.db.collection("users").doc(params.uid)),
            ]);
            assertAutomaticAssignmentStateOwnership({
                gatewayId: params.gatewayId,
                uid: params.uid,
                root: rootSnap.exists ? rootSnap.data() : undefined,
                user: userSnap.exists ? userSnap.data() : undefined,
            });
        }
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
function assertAutomaticAssignmentStateOwnership(input) {
    if (isOperatorManaged(input.root?.managedBy)) {
        throw new Error(`automatic assignment state fenced: gateway ${input.gatewayId} is operator-managed`);
    }
    const provisioning = recordOrEmpty(input.user?.provisioning);
    const openclaw = recordOrEmpty(provisioning.openclaw);
    if (isOperatorManaged(openclaw.managedBy)) {
        throw new Error(`automatic assignment state fenced: builder ${input.uid} is operator-managed`);
    }
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
