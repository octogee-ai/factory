import { createHash } from "node:crypto";
import { GATEWAYS_COLLECTION } from "./fleet-controller.js";
import { isGatewayMutableConfigForGateway, } from "./gateway-mutable-config.js";
import { IMAGE_TAG_PATTERN, isW9CandidateImageTag, } from "./image-tag.js";
import { GLM_GATEWAYS_COLLECTION } from "./glm.js";
// Simple-roll model (GATEWAY-SIMPLE-ROLL-SPEC): durable identity
// (gateways/{id}) + immutable releases (releases/{n}) + ONE stable-name
// realization per gateway (glmGateways/{gatewayId} runtime doc). A roll is a
// desiredRelease write; Kubernetes surge replacement is the only mechanism.
// gateways/{gatewayId}/releases/{n} and gateways/{gatewayId}/assignments/{uid}
// are subcollections of the durable gateway identity doc.
export const GATEWAY_RELEASES_SUBCOLLECTION = "releases";
export const GATEWAY_ASSIGNMENTS_SUBCOLLECTION = "assignments";
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
export function upgradeReleasePayloadSchema(payload, persistedPayloadHash) {
    if (typeof persistedPayloadHash !== "string" ||
        persistedPayloadHash !== releasePayloadValueHash(payload)) {
        return { status: "unsupported", reason: "payload-hash-mismatch" };
    }
    if (isReleasePayload(payload)) {
        return { status: "current", payload, payloadHash: persistedPayloadHash };
    }
    if (!isPlainRecord(payload) ||
        !Object.prototype.hasOwnProperty.call(payload, "macOpsTokenProtocol")) {
        return { status: "unsupported", reason: "unsupported-payload-schema" };
    }
    const upgraded = { ...payload };
    delete upgraded.macOpsTokenProtocol;
    if (!isReleasePayload(upgraded)) {
        return { status: "unsupported", reason: "unsupported-payload-schema" };
    }
    return {
        status: "upgraded",
        migration: "remove-retired-mac-ops-token-protocol",
        payload: upgraded,
        payloadHash: releasePayloadValueHash(upgraded),
    };
}
function hasReleasePayloadShape(value) {
    return !(Object.keys(value).some((field) => !RELEASE_PAYLOAD_FIELD_NAMES.has(field)) ||
        RELEASE_PAYLOAD_REQUIRED_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(value, field)));
}
function hasReleasePayloadIdentity(value) {
    return (typeof value.imageRepository === "string" &&
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
export function isAssignmentState(value) {
    return value === "serving" || value === "quiescing" || value === "migrating";
}
export function isGatewayRuntimeDoc(data) {
    if (!data || typeof data !== "object")
        return false;
    const d = data;
    return (d.docKind === "runtime" &&
        typeof d.gatewayId === "string" &&
        typeof d.release === "number" &&
        typeof d.lifecycle === "string");
}
// A gateways/{id} durable desired doc (GatewayDoc), distinct from a legacy
// GatewayDesiredState (no desiredRelease/latestRelease).
export function isGatewayDesiredDoc(data) {
    if (!data || typeof data !== "object")
        return false;
    const d = data;
    return (typeof d.gatewayId === "string" &&
        typeof d.desiredRelease === "number" &&
        typeof d.latestRelease === "number" &&
        (d.desiredStatus === "running" || d.desiredStatus === "paused" || d.desiredStatus === "retired"));
}
export function helmReleaseNameForGateway(gatewayId) {
    return `octogee-gw-${gatewayId}`;
}
// Kubernetes Service DNS names for the gateway's stable-name resources.
// Service-addressed `/g/{gatewayId}/…` targets `gateway-edge-{gatewayId}`;
// the chart renders both names directly from the bare gateway id.
export function gatewayEdgeServiceName(id) {
    return `gateway-edge-${id}`;
}
// The gateway pod Service (preview surface, port 9080).
export function gatewayPodServiceName(id) {
    return `octogee-gateway-${id}`;
}
// Deterministic, order-independent hash of a release payload. Used to reject a
// no-op release (payload equals the previous release) and to fingerprint a
// revision's rendered config. Non-cryptographic identity is not required; the
// only contract is: same normalized value → same hash, any change → different.
export function releasePayloadHash(payload) {
    return releasePayloadValueHash(payload);
}
function releasePayloadValueHash(payload) {
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
// Release-payload fields — audited via an immutable release; changing one is a
// roll. Listed for documentation + testing; the classifier does not need them
// because the conservative default already returns "release" for anything
// unlisted.
export const RELEASE_FIELDS = [
    "imageRepository",
    "imageTag",
    "testExperiment",
];
// gateways/{gatewayId} DOC fields that mutate without cutting a release.
// Separate-collection observations (assignment docs, runtime heartbeat /
// lastError) are not gateway-doc fields and are not enumerated here.
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
    "builderSlug",
    "openclawOverrides",
    "modelBrokerLimits",
    "preemption",
    "allocation",
    "desiredStatus",
    "idleSleep",
    "preemptionHandoff",
    "liveRelease",
    "retireAfter",
];
const GATEWAY_MUTABLE_SET = new Set(GATEWAY_MUTABLE_FIELDS);
// Conservative classifier over gateway-DOC and release-PAYLOAD field NAMES.
// Only explicitly enumerated gateway-mutable fields escape the default; every
// other field — including any new field added to the payload later — is
// release-audited. That default is the safety property the spec pins
// (operator, 2026-07-08).
export function classifyGatewayField(field) {
    if (GATEWAY_MUTABLE_SET.has(field))
        return "gateway-mutable";
    return "release";
}
function isDurablePlacementRoot(value, gatewayId) {
    return (isGatewayDesiredDoc(value) &&
        value.gatewayId === gatewayId &&
        isGatewayMutableConfigForGateway(value, gatewayId));
}
function placementRuntimeRejectReason(snap, gatewayId) {
    const data = snap.exists ? snap.data() : undefined;
    if (!isGatewayRuntimeDoc(data) || data.gatewayId !== gatewayId) {
        return "gateway-not-serving";
    }
    return data.lifecycle === "serving" ? null : "gateway-not-serving";
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
        const runtimeSnap = await txn.get(db.collection(GLM_GATEWAYS_COLLECTION).doc(params.gatewayId));
        const runtimeRejectReason = placementRuntimeRejectReason(runtimeSnap, params.gatewayId);
        if (runtimeRejectReason) {
            return { kind: "rejected", reason: runtimeRejectReason };
        }
        // Mirror + assignment are all-or-nothing: a serving assignment at epoch 0
        // (the steady baseline before any migration cutover bumps the epoch).
        txn.update(userRef, params.mirrorPatch);
        const assignmentDoc = {
            uid: params.uid,
            slug: params.slug,
            gatewayId: params.gatewayId,
            source: params.source,
            state: "serving",
            epoch: 0,
            updatedAt: params.now,
            updatedByOperationId: params.updatedByOperationId ?? null,
        };
        txn.set(assignmentRef, assignmentDoc);
        return { kind: "assigned", release: gatewayData.liveRelease };
    });
}
