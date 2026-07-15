import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GATEWAY_ASSIGNMENTS_SUBCOLLECTION, isAssignmentState, } from "@octogee/shared/types/gateway-releases";
function assignmentsCollection(db, gatewayId) {
    return db
        .collection(GATEWAYS_COLLECTION)
        .doc(gatewayId)
        .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION);
}
const ASSIGNMENT_SOURCES = new Set([
    "onboarding",
    "migrate-customer",
    "rollout",
    "repair",
]);
// A parsed AssignmentDoc or null when the stored shape is not a complete
// assignment — a partial/junk doc must never be resolved as a mount signal.
export function parseAssignmentDoc(uid, data) {
    if (!data)
        return null;
    const slug = data.slug;
    const gatewayId = data.gatewayId;
    const revisionId = data.revisionId;
    const release = data.release;
    const source = data.source;
    if (typeof slug !== "string" ||
        typeof gatewayId !== "string" ||
        typeof revisionId !== "string" ||
        typeof release !== "number" ||
        typeof source !== "string" ||
        !ASSIGNMENT_SOURCES.has(source)) {
        return null;
    }
    return {
        uid,
        slug,
        gatewayId,
        revisionId,
        release,
        source: source,
        // Pre-PR7 docs carry no roster fields: default to serving at epoch 0 (the
        // steady state before any flip) so they keep routing exactly as today.
        state: isAssignmentState(data.state) ? data.state : "serving",
        epoch: typeof data.epoch === "number" && data.epoch >= 0 ? data.epoch : 0,
        updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
        updatedByOperationId: typeof data.updatedByOperationId === "string" ? data.updatedByOperationId : null,
    };
}
export async function readAssignmentDocsForGateway(db, gatewayId) {
    const snap = await assignmentsCollection(db, gatewayId).get();
    const out = [];
    for (const doc of snap.docs) {
        const parsed = parseAssignmentDoc(doc.id, doc.data());
        if (parsed)
            out.push(parsed);
    }
    return out;
}
export async function readAssignmentDoc(db, gatewayId, uid) {
    const snap = await assignmentsCollection(db, gatewayId).doc(uid).get();
    if (!snap.exists)
        return null;
    return parseAssignmentDoc(uid, snap.data());
}
export async function deleteAssignmentDoc(db, gatewayId, uid) {
    await assignmentsCollection(db, gatewayId).doc(uid).delete();
}
export async function readLiveRevisionId(db, gatewayId) {
    const snap = await db.collection(GATEWAYS_COLLECTION).doc(gatewayId).get();
    if (!snap.exists)
        return null;
    const live = snap.data()?.liveRevisionId;
    return typeof live === "string" ? live : null;
}
// The revision-aware mount decision (GATEWAY-RELEASES-SPEC). An assigned builder
// mounts on the pod's revision iff:
//   - the pod has NO revision (legacy pod) → mount (byte-identical to today); or
//   - the user has an assignment doc → only on that assignment's revision; or
//   - the user is a gap user (no assignment doc) → only on the LIVE revision
//     (never on both revisions of a rolling gateway). When the live revision is
//     unknown (pre-backfill), a gap user still mounts — the safe default that
//     preserves today's single-revision behavior.
// Builder placement is decided by the caller from the user mirror; this predicate
// only resolves the serving revision.
export function mountsOnRevision(input) {
    if (!input.podRevisionId)
        return true;
    if (input.assignmentRevisionId != null) {
        return input.assignmentRevisionId === input.podRevisionId;
    }
    if (input.liveRevisionId == null)
        return true;
    return input.podRevisionId === input.liveRevisionId;
}
export function resolvePlacementRevision(input) {
    const { gateway, isRevisionReady } = input;
    const roll = gateway.roll;
    const revisionId = roll && roll.acceptingNewAssignments ? roll.targetRevisionId : gateway.liveRevisionId;
    const release = roll && roll.acceptingNewAssignments ? roll.toRelease : gateway.liveRelease;
    if (!revisionId)
        return { ok: false, reason: "no-live-revision" };
    if (!isRevisionReady(revisionId))
        return { ok: false, reason: "revision-not-ready" };
    return { ok: true, revisionId, release };
}
