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
    "repair",
]);
// A parsed AssignmentDoc or null when the stored shape is not a complete
// assignment — a partial/junk doc must never be resolved as a mount signal.
// Revision-era fields (revisionId, release) on legacy docs are ignored; the
// cutover script normalizes sources (e.g. retired "rollout") when it runs.
// Legacy docs predate createdAt; their updatedAt is the closest serving-since we have.
function assignmentCreatedAt(data) {
    if (typeof data.createdAt === "number")
        return data.createdAt;
    return typeof data.updatedAt === "number" ? data.updatedAt : 0;
}
export function parseAssignmentDoc(uid, data) {
    if (!data)
        return null;
    const slug = data.slug;
    const gatewayId = data.gatewayId;
    const source = data.source;
    if (typeof slug !== "string" ||
        typeof gatewayId !== "string" ||
        typeof source !== "string" ||
        !ASSIGNMENT_SOURCES.has(source)) {
        return null;
    }
    return {
        uid,
        slug,
        gatewayId,
        source: source,
        state: isAssignmentState(data.state) ? data.state : "serving",
        epoch: typeof data.epoch === "number" && data.epoch >= 0 ? data.epoch : 0,
        createdAt: assignmentCreatedAt(data),
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
