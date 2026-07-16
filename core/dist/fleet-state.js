import { GATEWAY_HEARTBEAT_INTERVAL_MS, GATEWAY_UNREACHABLE_AFTER_MS, GATEWAYS_COLLECTION, hasDurableOpenClawConfigControlProtocol, } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION, resolveUserGatewayShellState, } from "@octogee/shared/types/glm";
import { GATEWAY_ASSIGNMENTS_SUBCOLLECTION, } from "@octogee/shared/types/gateway-releases";
export async function writeGatewayHeartbeat(deps, snapshot) {
    if (!snapshot.revisionId) {
        throw new Error("revisionId is required for revision-scoped gateway heartbeat");
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
        .doc(snapshot.revisionId)
        .set({ heartbeat }, { merge: true });
}
// Migration cutover: move the customer's DESIRED assignment to the target gateway.
// Mounting and the mounted-set report are the reconcile/heartbeat's job (observed) —
// cutover only flips desired, so the source gateway evicts and the target mounts on
// their next reconcile tick. See FLEET-RECONCILE-SPEC. The mirrored user-doc shell
// state (gatewayProfile + shellsEnabled, read by the PWA) derives from the target
// gateway's class + this user's ownership — see resolveUserGatewayShellState.
export async function cutoverUserGatewayAndMarkMounted(deps, params) {
    const userRef = deps.db.collection("users").doc(params.uid);
    await deps.db.runTransaction(async (txn) => {
        const snap = await txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.toGatewayId));
        const shellState = resolveUserGatewayShellState(snap.exists ? snap.data() : undefined, params.uid);
        txn.update(userRef, {
            "provisioning.openclaw.gatewayId": params.toGatewayId,
            "provisioning.openclaw.gatewayAssignedAt": deps.serverTimestamp(),
            "provisioning.openclaw.gatewayProfile": shellState.gatewayProfile,
            "provisioning.openclaw.shellsEnabled": shellState.shellsEnabled,
        });
    });
}
function protocolV2PromotionIsExact(configRoll, operationId, sourceRevisionId, targetRevisionId) {
    if (!configRoll)
        return false;
    return [
        configRoll.phase === "promoted",
        configRoll.migrationId === `roll-config-${operationId}`,
        configRoll.sourceRevisionId === sourceRevisionId,
        configRoll.targetRevisionId === targetRevisionId,
        configRoll.freezeRef === `refs/octogee/system-config/freeze/${sourceRevisionId}`,
        typeof configRoll.freezeObject === "string" && /^[0-9a-f]{40}$/.test(configRoll.freezeObject),
        typeof configRoll.checkpointCommit === "string" && /^[0-9a-f]{40}$/.test(configRoll.checkpointCommit),
        typeof configRoll.configHash === "string" && /^[0-9a-f]{64}$/.test(configRoll.configHash),
        configRoll.candidateRef === `refs/octogee/system-config/candidate/${targetRevisionId}`,
        typeof configRoll.candidateCommit === "string" && /^[0-9a-f]{40}$/.test(configRoll.candidateCommit),
        typeof configRoll.candidateHash === "string" && /^[0-9a-f]{64}$/.test(configRoll.candidateHash),
        typeof configRoll.runtimeConfigHash === "string" && /^[0-9a-f]{64}$/.test(configRoll.runtimeConfigHash),
        configRoll.observedRevisionId === targetRevisionId,
        typeof configRoll.targetStartedAt === "number",
        typeof configRoll.imageTag === "string" && configRoll.imageTag.length > 0,
        typeof configRoll.buildSha === "string" && configRoll.buildSha.length > 0,
        typeof configRoll.openclawVersion === "string" && configRoll.openclawVersion.length > 0,
        typeof configRoll.provenAt === "number",
        configRoll.promotedCommit === configRoll.candidateCommit,
        typeof configRoll.promotedAt === "number" &&
            typeof configRoll.provenAt === "number" &&
            configRoll.promotedAt >= configRoll.provenAt,
    ].every(Boolean);
}
function recordOrEmpty(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return value;
}
function protocolV2TargetProofIsCurrent(configRoll, target, input) {
    const targetRecord = recordOrEmpty(target);
    const helm = recordOrEmpty(targetRecord.helm);
    const heartbeat = recordOrEmpty(targetRecord.heartbeat);
    const status = recordOrEmpty(heartbeat.configStatus);
    const owner = recordOrEmpty(status.controlOwner);
    const lastHeartbeatAt = millis(heartbeat.lastHeartbeatAt);
    const configObservedAt = millis(status.observedAt);
    return [
        targetRecord.docKind === "revision",
        targetRecord.gateway === input.gatewayId,
        targetRecord.revisionId === input.revisionId,
        targetRecord.release === input.release,
        helm.imageTag === configRoll.imageTag,
        heartbeat.status === "ready",
        freshObservation(lastHeartbeatAt, input.now),
        heartbeat.startedAt === configRoll.targetStartedAt,
        heartbeat.version === configRoll.buildSha,
        hasDurableOpenClawConfigControlProtocol(status),
        freshObservation(configObservedAt, input.now),
        status.runtimeReady === true,
        status.openclawVersion === configRoll.openclawVersion,
        status.bootRole === "target-candidate",
        owner.migrationId === configRoll.migrationId,
        owner.sourceRevisionId === configRoll.sourceRevisionId,
        owner.targetRevisionId === configRoll.targetRevisionId,
        status.checkpointCommit === configRoll.checkpointCommit,
        status.configHash === configRoll.configHash,
        status.candidateCommit === configRoll.candidateCommit,
        status.candidateHash === configRoll.candidateHash,
    ].every(Boolean);
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
function freshObservation(observedAt, now) {
    return observedAt !== null &&
        observedAt <= now + GATEWAY_HEARTBEAT_INTERVAL_MS &&
        now - observedAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}
// Atomic cutover (GATEWAY-RELEASES-SPEC, PR5 review P0). The mirror move AND the
// assignment write commit in ONE Firestore transaction, so a crash/throw leaves
// NEITHER — never a half-state where the mirror points at the target while the
// assignment still says source (which would make the target pod treat the
// customer as a gap user and mount them on the wrong revision). Cross-gateway
// also drops the stale source assignment in the same transaction.
//
// PR7: the commit is also the ROSTER FLIP. The written assignment is stamped
// state:"serving" and its epoch is bumped past the customer's prior assignment
// (source-gateway doc when cross-gateway, same doc on a revision drain) — the
// per-customer monotonic epoch the edge's intra-family forwarding rides.
export async function commitCutoverAtomic(deps, params) {
    const nowMs = deps.now ? deps.now().getTime() : Date.now();
    await deps.db.runTransaction(async (txn) => {
        const prior = await readPriorAssignment(txn, deps.db, params);
        const targetRootSnap = await txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.toGatewayId));
        const targetRoot = targetRootSnap.exists ? targetRootSnap.data() : undefined;
        assertTargetAcceptsCutover(targetRoot, params.toGatewayId);
        if (params.rollFence) {
            await assertRollFenceCurrent({ txn, db: deps.db, params, targetRoot, prior, nowMs });
        }
        updateUserMirror(txn, deps, params, targetRoot);
        updateAssignment(txn, deps.db, params, prior.epoch, nowMs);
    });
}
async function readPriorAssignment(txn, db, params) {
    if (!params.assignment)
        return { epoch: 0, revisionId: undefined };
    const snapshot = await txn.get(assignmentRef(db, params.fromGatewayId, params.uid));
    const epoch = snapshot.exists ? snapshot.data()?.epoch : undefined;
    return {
        epoch: typeof epoch === "number" && epoch >= 0 ? epoch : 0,
        revisionId: snapshot.exists ? snapshot.data()?.revisionId : undefined,
    };
}
function assertTargetAcceptsCutover(targetRoot, gatewayId) {
    if (targetRoot?.desiredStatus === "retired" || targetRoot?.retirementClaim != null) {
        throw new Error(`gateway ${gatewayId} has a current retirement claim`);
    }
}
async function assertRollFenceCurrent(input) {
    const { txn, db, params, targetRoot, prior, nowMs } = input;
    const fence = params.rollFence;
    const roll = targetRoot?.roll;
    const protocolV2Roll = roll?.systemConfigRoll !== undefined;
    assertCurrentRoll(params, targetRoot, roll, protocolV2Roll);
    if (protocolV2Roll) {
        await assertProtocolV2ProofCurrent(txn, db, params, roll, nowMs);
    }
    assertSourceCheckpointCurrent(roll, fence.sourceConfigCheckpoint);
    assertSourceAssignmentCurrent(targetRoot, fence, prior);
    if (fence.configReady) {
        await assertLegacyConfigProofCurrent(txn, db, fence);
    }
}
function assertCurrentRoll(params, targetRoot, roll, protocolV2Roll) {
    const fence = params.rollFence;
    const current = [
        protocolV2Roll || targetRoot?.desiredRelease === fence.targetRelease,
        roll?.operationId === fence.operationId,
        roll?.targetRevisionId === fence.targetRevisionId,
        roll?.toRelease === fence.targetRelease,
        params.assignment?.revisionId === fence.targetRevisionId,
    ].every(Boolean);
    if (!current)
        throw new Error("stale release-roll fence refused cutover");
}
async function assertProtocolV2ProofCurrent(txn, db, params, roll, nowMs) {
    const fence = params.rollFence;
    const configRoll = roll.systemConfigRoll;
    if (!protocolV2PromotionIsExact(configRoll, fence.operationId, fence.sourceRevisionId, fence.targetRevisionId)) {
        throw new Error("protocol-v2 candidate is not durably promoted at cutover");
    }
    const targetSnap = await txn.get(db.collection(GLM_GATEWAYS_COLLECTION).doc(fence.targetRevisionId));
    const target = targetSnap.exists ? targetSnap.data() : undefined;
    if (!protocolV2TargetProofIsCurrent(configRoll, target, {
        gatewayId: params.toGatewayId,
        revisionId: fence.targetRevisionId,
        release: fence.targetRelease,
        now: nowMs,
    })) {
        throw new Error("protocol-v2 target candidate proof changed before cutover");
    }
}
function assertSourceCheckpointCurrent(roll, expected) {
    if (!expected)
        return;
    const checkpoint = roll?.systemConfigCheckpoint;
    const current = [
        checkpoint?.migrationId === expected.migrationId,
        checkpoint?.checkpointCommit === expected.checkpointCommit,
        checkpoint?.configHash === expected.configHash,
        checkpoint?.sourceUnfrozenAt === null,
    ].every(Boolean);
    if (!current)
        throw new Error("source config checkpoint changed before release-roll cutover");
}
function assertSourceAssignmentCurrent(root, fence, prior) {
    const assigned = prior.revisionId === fence.sourceRevisionId && prior.epoch === fence.sourceEpoch;
    const unassigned = prior.revisionId === undefined &&
        fence.sourceEpoch === 0 &&
        root?.liveRevisionId === fence.sourceRevisionId;
    if (!assigned && !unassigned) {
        throw new Error("source assignment changed after release-roll proof");
    }
}
async function assertLegacyConfigProofCurrent(txn, db, fence) {
    const proof = fence.configReady;
    const targetSnap = await txn.get(db.collection(GLM_GATEWAYS_COLLECTION).doc(fence.targetRevisionId));
    const target = targetSnap.exists ? targetSnap.data() : undefined;
    const systemConfig = target?.systemConfig;
    const heartbeat = target?.heartbeat;
    const current = [
        systemConfig?.configReady === true,
        systemConfig?.observedRevisionId === proof.observedRevisionId,
        systemConfig?.acceptedCommit === proof.acceptedCommit,
        systemConfig?.configReadyAt === proof.configReadyAt,
        systemConfig?.runtimeConfigHash === proof.runtimeConfigHash,
    ].every(Boolean);
    if (!current)
        throw new Error("target config proof changed before release-roll cutover");
    if (typeof heartbeat?.startedAt !== "number" || heartbeat.startedAt > proof.configReadyAt) {
        throw new Error("target restarted after config proof before release-roll cutover");
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
        revisionId: params.assignment.revisionId,
        release: params.assignment.release,
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
// Flip ONLY the roster state on an existing assignment — revision and epoch
// stay put. The gated quiesce writes "quiescing" here BEFORE the source pod is
// quiesced (blocking source serving ahead of the target ever serving — no
// double-serve window); a pre-cutover rollback writes "serving" to restore the
// source. No-op when the customer has no assignment doc (legacy migration):
// there is no roster entry for the edge to consult, so nothing to gate.
export async function markAssignmentState(deps, params) {
    await deps.db.runTransaction(async (txn) => {
        const ref = assignmentRef(deps.db, params.gatewayId, params.uid);
        const snap = await txn.get(ref);
        if (!snap.exists)
            return;
        txn.update(ref, { state: params.state });
    });
}
function assignmentRef(db, gatewayId, uid) {
    const gatewayDoc = db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
    if (!gatewayDoc.collection) {
        throw new Error("FleetStateFirestore doc ref does not support subcollections");
    }
    return gatewayDoc.collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(uid);
}
