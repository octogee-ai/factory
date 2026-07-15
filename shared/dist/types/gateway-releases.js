import { createHash } from "node:crypto";
import { GATEWAYS_COLLECTION } from "./fleet-controller.js";
import { isGatewayMutableConfigForGateway, } from "./gateway-mutable-config.js";
import { IMAGE_TAG_PATTERN, isW9CandidateImageTag, } from "./image-tag.js";
import { GLM_GATEWAYS_COLLECTION } from "./glm.js";
// Step 2 release/revision model (GATEWAY-RELEASES-SPEC). These types describe
// the desired-identity + immutable-release + revision-realization split that
// supersedes the single overloaded glmGateways desired doc. PR1 adds the
// schema + helpers only; no writer or reader is rerouted yet.
// gateways/{gatewayId}/releases/{n} and gateways/{gatewayId}/assignments/{uid}
// are subcollections of the durable gateway identity doc.
export const GATEWAY_RELEASES_SUBCOLLECTION = "releases";
export const GATEWAY_ASSIGNMENTS_SUBCOLLECTION = "assignments";
// Cowboy-written tombstone table (top-level collection, doc id = revisionId).
// The gateway-router reads it ONLY on the revision-pinned MISS path to answer a
// retired /r/{n} with a typed revision_gone 404 (+ current-revision pointer),
// never by asking a dead pod. Service-addressed traffic never touches it.
export const REVISION_TOMBSTONES_COLLECTION = "revisionTombstones";
export const W9_CANDIDATE_MANIFEST_PATH = "infra/gateway/openclaw-candidates/agent-conversation.json";
export const W9_MATTERMOST_OVERLAY_VALUES_PATH = "infra/candidates/values.mattermost-silent-post.yaml";
export const W9_GATEWAY_EDGE_IMAGE_REPOSITORY = "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DIGEST_BOUND_IMAGE_REFERENCE_PATTERN = /^[a-z0-9][a-z0-9./_-]*:[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/;
export function isW9TestPublisherLiveExperiment(value) {
    if (!isPlainRecord(value) || value.kind !== "w9-agent-conversation" || value.mode !== "publisher-live") {
        return false;
    }
    const candidateManifest = value.candidateManifest;
    const mattermostOverlay = value.mattermostOverlay;
    return (isPlainRecord(candidateManifest) &&
        candidateManifest.path === W9_CANDIDATE_MANIFEST_PATH &&
        typeof candidateManifest.sha256 === "string" &&
        SHA256_PATTERN.test(candidateManifest.sha256) &&
        isPlainRecord(mattermostOverlay) &&
        mattermostOverlay.valuesPath === W9_MATTERMOST_OVERLAY_VALUES_PATH &&
        typeof mattermostOverlay.imageReference === "string" &&
        DIGEST_BOUND_IMAGE_REFERENCE_PATTERN.test(mattermostOverlay.imageReference));
}
const RELEASE_PAYLOAD_FIELD_NAMES = new Set([
    "macOpsTokenProtocol",
    "imageRepository",
    "imageTag",
    "gatewayEdgeImage",
    "testExperiment",
]);
const RELEASE_PAYLOAD_REQUIRED_FIELDS = [
    "imageRepository",
    "imageTag",
];
function isPlainRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isReleasePayload(value) {
    if (!isPlainRecord(value))
        return false;
    if (!hasReleasePayloadShape(value) || !hasReleasePayloadIdentity(value))
        return false;
    if (value.testExperiment === undefined) {
        return !isW9CandidateImageTag(value.imageTag) && value.gatewayEdgeImage === undefined;
    }
    return (isW9CandidateImageTag(value.imageTag) &&
        isW9TestPublisherLiveExperiment(value.testExperiment) &&
        isW9GatewayEdgeImage(value.gatewayEdgeImage, value.imageTag));
}
function hasReleasePayloadShape(value) {
    return !(Object.keys(value).some((field) => !RELEASE_PAYLOAD_FIELD_NAMES.has(field)) ||
        RELEASE_PAYLOAD_REQUIRED_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(value, field)));
}
function hasReleasePayloadIdentity(value) {
    return ((value.macOpsTokenProtocol === undefined ||
        value.macOpsTokenProtocol === 1 ||
        value.macOpsTokenProtocol === 2) &&
        typeof value.imageRepository === "string" &&
        value.imageRepository.length > 0 &&
        typeof value.imageTag === "string" &&
        value.imageTag.length > 0 &&
        IMAGE_TAG_PATTERN.test(value.imageTag));
}
function w9CandidateImageName(imageTag) {
    return imageTag.slice(0, imageTag.indexOf("@"));
}
export function isW9GatewayEdgeImage(value, gatewayImageTag) {
    return (isPlainRecord(value) &&
        value.imageRepository === W9_GATEWAY_EDGE_IMAGE_REPOSITORY &&
        typeof value.imageTag === "string" &&
        isW9CandidateImageTag(value.imageTag) &&
        isW9CandidateImageTag(gatewayImageTag) &&
        w9CandidateImageName(value.imageTag) === w9CandidateImageName(gatewayImageTag));
}
export const CURRENT_MAC_OPS_TOKEN_PROTOCOL = 2;
export function releaseMacOpsTokenProtocol(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return null;
    const protocol = payload.macOpsTokenProtocol;
    if (protocol === undefined || protocol === 1)
        return 1;
    return protocol === 2 ? 2 : null;
}
export function isAssignmentState(value) {
    return value === "serving" || value === "quiescing" || value === "migrating";
}
// Internal-only headers a forwarded intra-family hop carries between two
// gateway-edge sidecars of the SAME gateway. The public gateway-router strips
// them from every inbound request (they must never be client-controllable) and
// an edge never forwards a request that already carries the hop header — one
// hop max, by construction.
export const INTRA_FAMILY_HOP_HEADER = "x-octogee-intra-family-hop";
export const ASSIGNMENT_EPOCH_HEADER = "x-octogee-assignment-epoch";
export const INTERNAL_ROUTING_HEADERS = [
    INTRA_FAMILY_HOP_HEADER,
    ASSIGNMENT_EPOCH_HEADER,
];
// glmGateways doc-kind discriminators. During expand the collection holds legacy
// bare-id desired docs alongside {gw}-rN revision-realization docs; every
// iterator routes through these so it treats each doc correctly.
export function isRevisionRealizationDoc(data) {
    if (!data || typeof data !== "object")
        return false;
    const d = data;
    if (d.docKind === "revision")
        return true;
    // Structural fallback for a revision doc written before docKind existed.
    return (typeof d.revisionId === "string" &&
        typeof d.gateway === "string" &&
        typeof d.lifecycle === "string");
}
export function isGatewayLegacyBackfill(value) {
    if (!isPlainRecord(value) || !Array.isArray(value.sourceGlmGatewayIds))
        return false;
    const sourceGlmGatewayIds = value.sourceGlmGatewayIds;
    return (sourceGlmGatewayIds.length > 0 &&
        sourceGlmGatewayIds.every((id) => typeof id === "string" && id.length > 0) &&
        new Set(sourceGlmGatewayIds).size === sourceGlmGatewayIds.length &&
        typeof value.startedAt === "number" &&
        Number.isFinite(value.startedAt) &&
        value.startedAt >= 0);
}
// A new gateways/{id} durable desired doc (GatewayDoc). Distinct from a legacy
// GatewayDesiredState (no desiredRelease/latestRelease) and a revision doc.
export function isGatewayDesiredDoc(data) {
    if (!data || typeof data !== "object")
        return false;
    const d = data;
    return (typeof d.gatewayId === "string" &&
        typeof d.desiredRelease === "number" &&
        typeof d.latestRelease === "number" &&
        (d.desiredStatus === "running" || d.desiredStatus === "paused" || d.desiredStatus === "retired") &&
        (d.legacyBackfill === undefined ||
            d.legacyBackfill === null ||
            isGatewayLegacyBackfill(d.legacyBackfill)));
}
// Revision id convention: {gatewayId}-r{release}. Blue/green are transient roll
// ROLES (rollRole), never encoded into identity.
export function revisionIdForRelease(gatewayId, release) {
    return `${gatewayId}-r${release}`;
}
// Every revision the durable root references or intends to realize: live +
// traffic + the desired release + BOTH endpoints of any recorded roll — a
// parked failed roll still owns its revisions until an operator resolves it.
// Recovery primitives (orphan-revision retire, stranded-assignment reset)
// refuse to touch a referenced revision; this is deliberately WIDER than the
// renderer's selection, which excludes failed rolls and desired-only releases.
export function rootReferencedRevisionIds(root) {
    const ids = new Set();
    if (root.liveRevisionId)
        ids.add(root.liveRevisionId);
    if (root.trafficRevisionId)
        ids.add(root.trafficRevisionId);
    ids.add(revisionIdForRelease(root.gatewayId, root.desiredRelease));
    if (root.roll) {
        if (root.roll.sourceRevisionId)
            ids.add(root.roll.sourceRevisionId);
        ids.add(root.roll.targetRevisionId);
    }
    return ids;
}
export function helmReleaseNameForRevision(revisionId) {
    return `octogee-gw-${revisionId}`;
}
// Kubernetes Service DNS names, keyed by the ADDRESSED id. Service-addressed
// `/g/{gatewayId}/…` targets the per-gateway Service `gateway-edge-{gatewayId}`
// whose selector Cowboy points at the serving revision; revision-pinned
// `/g/{gatewayId}/r/{n}/…` targets the revision's own Service
// `gateway-edge-{revisionId}`. Both share one formula — the router passes the
// gateway id for the service form and the revision id for the pinned form.
export function gatewayEdgeServiceName(id) {
    return `gateway-edge-${id}`;
}
// The gateway pod Service (preview surface, port 9080), same addressing split.
export function gatewayPodServiceName(id) {
    return `octogee-gateway-${id}`;
}
export function revisionTombstoneDocId(gatewayId, revision) {
    return revisionIdForRelease(gatewayId, revision);
}
export function isRevisionTombstone(data) {
    if (!data || typeof data !== "object")
        return false;
    const d = data;
    return (typeof d.gatewayId === "string" &&
        typeof d.revision === "number" &&
        typeof d.revisionId === "string" &&
        (d.currentRevisionId === null || typeof d.currentRevisionId === "string") &&
        typeof d.retiredAt === "number");
}
// Deterministic, order-independent hash of a release payload. Used to reject a
// no-op release (payload equals the previous release) and to fingerprint a
// revision's rendered config. Non-cryptographic identity is not required; the
// only contract is: same normalized value → same hash, any change → different.
export function releasePayloadHash(payload) {
    return createHash("sha256")
        .update(canonicalJson(payload))
        .digest("hex");
}
function canonicalJson(value) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
    }
    const entries = Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => compareKeys(a, b));
    return `{${entries
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
        .join(",")}}`;
}
function compareKeys(a, b) {
    if (a < b)
        return -1;
    if (a > b)
        return 1;
    return 0;
}
// Release-payload fields that force a NEW revision when they change. Listed for
// documentation + testing; the classifier does not need them because the
// conservative default already returns "new-revision" for anything unlisted.
export const RELEASE_NEW_REVISION_FIELDS = [
    "imageRepository",
    "imageTag",
    "macOpsTokenProtocol",
    "testExperiment",
];
// Release-payload fields that are release-audited but may reconcile IN PLACE on
// the live revision (broker-consumed after request time; no pod restart).
export const RELEASE_IN_PLACE_FIELDS = [];
// gateways/{gatewayId} DOC fields that mutate without cutting a release. The
// spec's "gateway mutable without release" list also names assignment docs,
// revision heartbeat, and revision lastError — those live in SEPARATE
// collections (gateways/{id}/assignments/{uid}, glmGateways/{revisionId}), not
// as gateway-doc field names, so they are not enumerated here.
export const GATEWAY_MUTABLE_FIELDS = [
    "profile",
    "gatewayClass",
    "imageProfile",
    "sizingTier",
    "computeClass",
    "gcpProject",
    "gatewayContainerSecurityContext",
    "serviceAccountName",
    "serviceAccount",
    "operatorAccess",
    "ownerUid",
    "coOwnerUids",
    "builderSlug",
    "openclawOverrides",
    "modelBrokerLimits",
    "preemption",
    "desiredStatus",
    "roll",
    "idleSleep",
    "preemptionHandoff",
    "liveRelease",
    "liveRevisionId",
    "trafficRevisionId",
    "retireAfter",
];
const IN_PLACE_SET = new Set(RELEASE_IN_PLACE_FIELDS);
const GATEWAY_MUTABLE_SET = new Set(GATEWAY_MUTABLE_FIELDS);
// Conservative classifier over gateway-DOC and release-PAYLOAD field NAMES.
// Only explicitly enumerated in-place / gateway-mutable fields escape the
// default; every other field — including any new field added to the payload
// later — cuts a new revision. That default is the safety property the spec
// pins (operator, 2026-07-08). Separate-collection observations (assignment
// docs, revision heartbeat/lastError) are not gateway-doc fields and are not
// classified here.
export function classifyGatewayField(field) {
    if (IN_PLACE_SET.has(field))
        return "in-place";
    if (GATEWAY_MUTABLE_SET.has(field))
        return "gateway-mutable";
    return "new-revision";
}
function isDurablePlacementRoot(value, gatewayId) {
    return (isGatewayDesiredDoc(value) &&
        value.gatewayId === gatewayId &&
        isGatewayMutableConfigForGateway(value, gatewayId));
}
function hasCanonicalPlacementRevision(gatewayId, revisionId, release) {
    return (typeof revisionId === "string" &&
        typeof release === "number" &&
        Number.isInteger(release) &&
        release > 0 &&
        revisionId === revisionIdForRelease(gatewayId, release));
}
function placementRevisionRejectReason(snap, gatewayId, revisionId, release) {
    const data = snap.exists ? snap.data() : undefined;
    if (!isRevisionRealizationDoc(data) ||
        data.revisionId !== revisionId ||
        data.gateway !== gatewayId ||
        data.release !== release) {
        return "revision-identity-invalid";
    }
    return data.lifecycle === "serving" ? null : "revision-not-ready";
}
async function preserveExistingAssignment(txn, assignmentRef, userRef, params) {
    if (params.assignmentWrite !== "create-if-missing")
        return false;
    const assignmentSnap = await txn.get(assignmentRef);
    if (!assignmentSnap.exists)
        return false;
    txn.update(userRef, params.mirrorPatch);
    return true;
}
export async function commitPlacementAtomic(db, params) {
    const userRef = db.collection("users").doc(params.uid);
    const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(params.gatewayId);
    const assignmentRef = gatewayRef
        .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
        .doc(params.uid);
    return db.runTransaction(async (txn) => {
        const gatewaySnap = await txn.get(gatewayRef);
        const gatewayData = gatewaySnap.exists ? gatewaySnap.data() : undefined;
        if (!gatewaySnap.exists) {
            txn.update(userRef, params.mirrorPatch);
            return { kind: "mirror-only" };
        }
        if (!isDurablePlacementRoot(gatewayData, params.gatewayId)) {
            return { kind: "rejected", reason: "gateway-root-invalid" };
        }
        if (gatewayData.desiredStatus !== "running") {
            return { kind: "rejected", reason: "gateway-not-running" };
        }
        if (await preserveExistingAssignment(txn, assignmentRef, userRef, params)) {
            return { kind: "assignment-preserved" };
        }
        const roll = gatewayData.roll;
        const revisionId = roll && roll.acceptingNewAssignments ? roll.targetRevisionId : gatewayData.liveRevisionId;
        const release = roll && roll.acceptingNewAssignments ? roll.toRelease : gatewayData.liveRelease;
        if (revisionId === null || release === null) {
            return { kind: "rejected", reason: "no-live-revision" };
        }
        if (!hasCanonicalPlacementRevision(params.gatewayId, revisionId, release)) {
            return { kind: "rejected", reason: "revision-identity-invalid" };
        }
        const revisionSnap = await txn.get(db.collection(GLM_GATEWAYS_COLLECTION).doc(revisionId));
        const revisionRejectReason = placementRevisionRejectReason(revisionSnap, params.gatewayId, revisionId, release);
        if (revisionRejectReason) {
            return { kind: "rejected", reason: revisionRejectReason };
        }
        // Mirror + assignment are all-or-nothing: a serving assignment at epoch 0
        // (the steady baseline before any cutover flip bumps the epoch).
        txn.update(userRef, params.mirrorPatch);
        const assignmentDoc = {
            uid: params.uid,
            slug: params.slug,
            gatewayId: params.gatewayId,
            revisionId,
            release,
            source: params.source,
            state: "serving",
            epoch: 0,
            updatedAt: params.now,
            updatedByOperationId: params.updatedByOperationId ?? null,
        };
        txn.set(assignmentRef, assignmentDoc);
        return { kind: "assigned", revisionId, release };
    });
}
