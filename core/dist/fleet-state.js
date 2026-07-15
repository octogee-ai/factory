import { GATEWAYS_COLLECTION, } from "@octogee/shared/types/fleet-controller";
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
        let priorEpoch = 0;
        if (params.assignment) {
            const priorSnap = await txn.get(assignmentRef(deps.db, params.fromGatewayId, params.uid));
            const rawEpoch = priorSnap.exists ? priorSnap.data()?.epoch : undefined;
            priorEpoch = typeof rawEpoch === "number" && rawEpoch >= 0 ? rawEpoch : 0;
        }
        if (params.flipMirror) {
            const gatewaySnap = await txn.get(deps.db.collection(GATEWAYS_COLLECTION).doc(params.toGatewayId));
            const shellState = resolveUserGatewayShellState(gatewaySnap.exists ? gatewaySnap.data() : undefined, params.uid);
            txn.update(deps.db.collection("users").doc(params.uid), {
                "provisioning.openclaw.gatewayId": params.toGatewayId,
                "provisioning.openclaw.gatewayAssignedAt": deps.serverTimestamp(),
                "provisioning.openclaw.gatewayProfile": shellState.gatewayProfile,
                "provisioning.openclaw.shellsEnabled": shellState.shellsEnabled,
            });
        }
        if (params.assignment) {
            txn.set(assignmentRef(deps.db, params.toGatewayId, params.uid), {
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
                txn.delete(assignmentRef(deps.db, params.fromGatewayId, params.uid));
            }
        }
    });
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
