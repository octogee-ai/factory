import { createHash } from "node:crypto";
import { GATEWAYS_COLLECTION } from "./fleet-controller.js";
import { projectGatewayMutableConfigForGateway, } from "./gateway-mutable-config.js";
import { IMAGE_TAG_PATTERN } from "./image-tag.js";
import { GLM_GATEWAYS_COLLECTION, isOperatorManaged, } from "./glm.js";
// Simple-roll model (GATEWAY-SIMPLE-ROLL-SPEC): durable identity
// (gateways/{id}) + immutable releases (releases/{n}) + ONE stable-name
// realization per gateway (glmGateways/{gatewayId} runtime doc). A roll is a
// desiredRelease write; Kubernetes surge replacement is the only mechanism.
// gateways/{gatewayId}/releases/{n} and gateways/{gatewayId}/assignments/{uid}
// are subcollections of the durable gateway identity doc.
export const GATEWAY_RELEASES_SUBCOLLECTION = "releases";
export const GATEWAY_ASSIGNMENTS_SUBCOLLECTION = "assignments";
const DIGEST_BOUND_IMAGE_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/;
const RELEASE_PAYLOAD_FIELD_NAMES = new Set([
    "imageRepository",
    "imageTag",
    "openclawSourceSha",
    "profileImages",
    "gatewayEdgeImage",
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
    if (value.openclawSourceSha !== undefined &&
        (typeof value.openclawSourceSha !== "string" || !/^[a-f0-9]{40}$/.test(value.openclawSourceSha))) {
        return false;
    }
    if (value.profileImages !== undefined &&
        !isGatewayProfileImages(value.profileImages, value.imageRepository, value.imageTag)) {
        return false;
    }
    return value.gatewayEdgeImage === undefined ||
        isGatewayEdgeImage(value.gatewayEdgeImage, value.imageRepository);
}
function isGatewayProfileImages(value, gatewayImageRepository, gatewayImageTag) {
    if (!isPlainRecord(value) || Object.keys(value).length !== 1)
        return false;
    const builder = value.builder;
    if (!isPlainRecord(builder) || Object.keys(builder).length !== 2)
        return false;
    const gatewayPackageSuffix = "/octogee-gateway";
    const expectedRepository = gatewayImageRepository.endsWith(gatewayPackageSuffix)
        ? `${gatewayImageRepository.slice(0, -gatewayPackageSuffix.length)}/octogee-gateway-builder`
        : "";
    return (builder.imageRepository === expectedRepository &&
        typeof builder.imageTag === "string" &&
        DIGEST_BOUND_IMAGE_TAG_PATTERN.test(builder.imageTag) &&
        builder.imageTag.split("@", 1)[0] === gatewayImageTag.split("@", 1)[0]);
}
export function isGatewayEdgeImage(value, gatewayImageRepository) {
    const gatewayPackageSuffix = "/octogee-gateway";
    const expectedRepository = gatewayImageRepository.endsWith(gatewayPackageSuffix)
        ? `${gatewayImageRepository.slice(0, -gatewayPackageSuffix.length)}/gateway-edge`
        : "";
    return (isPlainRecord(value) &&
        value.imageRepository === expectedRepository &&
        typeof value.imageTag === "string" &&
        IMAGE_TAG_PATTERN.test(value.imageTag));
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
export function isAssignmentState(value) {
    return value === "serving" || value === "quiescing" || value === "migrating";
}
export function hasFreshReadyKubernetesObservation(runtime, nowMs, maxAgeMs) {
    const observation = runtime.kubernetes;
    return observation?.status === "ready" &&
        Number.isSafeInteger(observation.totalPods) &&
        observation.totalPods > 0 &&
        Number.isSafeInteger(observation.readyPods) &&
        observation.readyPods > 0 &&
        Number.isFinite(observation.observedAt) &&
        nowMs >= observation.observedAt &&
        nowMs - observation.observedAt <= maxAgeMs;
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
        (d.desiredStatus === "running" ||
            d.desiredStatus === "paused" ||
            d.desiredStatus === "draining" ||
            d.desiredStatus === "retired"));
}
export function projectGatewayDesiredRootForGateway(value, gatewayId) {
    if (!isGatewayDesiredDoc(value) || value.gatewayId !== gatewayId)
        return null;
    const projected = projectGatewayMutableConfigForGateway(value, gatewayId);
    return projected;
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
];
// gateways/{gatewayId} DOC fields that mutate without cutting a release.
// Separate-collection observations (assignment docs, runtime heartbeat /
// lastError) are not gateway-doc fields and are not enumerated here.
export const GATEWAY_MUTABLE_FIELDS = [
    "profile",
    "gatewayClass",
    "imageProfile",
    "sizingTier",
    "gcpProject",
    "gatewayContainerSecurityContext",
    "serviceAccountName",
    "serviceAccount",
    "builderAccess",
    "ownerUid",
    "builderSlug",
    "openclawOverrides",
    "modelBrokerLimits",
    "allocation",
    "desiredStatus",
    "managedBy",
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
    return projectGatewayDesiredRootForGateway(value, gatewayId) !== null;
}
function placementRuntimeRejectReason(snap, gatewayId) {
    const data = snap.exists ? snap.data() : undefined;
    if (!isGatewayRuntimeDoc(data) || data.gatewayId !== gatewayId) {
        return "gateway-not-serving";
    }
    return data.lifecycle === "serving" ? null : "gateway-not-serving";
}
function builderIsOperatorManaged(data) {
    const provisioning = data?.provisioning;
    if (!provisioning || typeof provisioning !== "object" || Array.isArray(provisioning)) {
        return false;
    }
    const openclaw = provisioning.openclaw;
    if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw))
        return false;
    return isOperatorManaged(openclaw.managedBy);
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
function automaticBuilderRejectReason(userData, params) {
    if (!params.automatic)
        return null;
    return builderIsOperatorManaged(userData)
        ? "builder-operator-managed"
        : null;
}
function placementGatewayRejectReason(gatewayData, params) {
    if (!isDurablePlacementRoot(gatewayData, params.gatewayId))
        return "gateway-root-invalid";
    if (params.automatic && isOperatorManaged(gatewayData.managedBy)) {
        return "gateway-operator-managed";
    }
    return gatewayData.desiredStatus === "running" ? null : "gateway-not-running";
}
async function placementUserWriteContext(db, txn, userRef, params) {
    const userSnap = params.automatic || params.atomicCreate
        ? await txn.get(userRef)
        : null;
    const userData = userSnap?.exists ? userSnap.data() : undefined;
    const atomicCreate = params.atomicCreate;
    const shouldCreate = Boolean(atomicCreate &&
        !Object.prototype.hasOwnProperty.call(userData ?? {}, atomicCreate.userField));
    const mirrorPatch = shouldCreate
        ? { ...params.mirrorPatch, ...atomicCreate.userPatch }
        : params.mirrorPatch;
    return {
        userData,
        mirrorPatch,
        applyAtomicWrites() {
            if (!shouldCreate || !atomicCreate)
                return;
            for (const write of atomicCreate.writes) {
                txn.set(db.collection(write.collection).doc(write.document), write.data);
            }
        },
    };
}
function commitMissingGateway(txn, userRef, params, mirrorPatch, applyAtomicWrites) {
    if (params.requireDurableGateway) {
        return { kind: "rejected", reason: "gateway-root-invalid" };
    }
    txn.update(userRef, mirrorPatch);
    applyAtomicWrites();
    return { kind: "mirror-only" };
}
async function readServingRuntime(db, txn, gatewayId) {
    const runtimeSnap = await txn.get(db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId));
    const reason = placementRuntimeRejectReason(runtimeSnap, gatewayId);
    if (reason)
        return { reason };
    const runtime = runtimeSnap.data();
    return runtime ? { runtime } : { reason: "gateway-not-serving" };
}
export async function commitPlacementAtomic(db, params) {
    const userRef = db.collection("users").doc(params.uid);
    const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(params.gatewayId);
    const assignmentRef = gatewayRef
        .collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION)
        .doc(params.uid);
    return db.runTransaction(async (txn) => {
        const { userData, mirrorPatch, applyAtomicWrites } = await placementUserWriteContext(db, txn, userRef, params);
        const gatewaySnap = await txn.get(gatewayRef);
        const gatewayData = gatewaySnap.exists ? gatewaySnap.data() : undefined;
        const builderRejectReason = automaticBuilderRejectReason(userData, params);
        if (builderRejectReason)
            return { kind: "rejected", reason: builderRejectReason };
        if (!gatewaySnap.exists) {
            return commitMissingGateway(txn, userRef, params, mirrorPatch, applyAtomicWrites);
        }
        const gatewayRejectReason = placementGatewayRejectReason(gatewayData, params);
        if (gatewayRejectReason)
            return { kind: "rejected", reason: gatewayRejectReason };
        if (!isDurablePlacementRoot(gatewayData, params.gatewayId))
            return { kind: "rejected", reason: "gateway-root-invalid" };
        const runtimeResult = await readServingRuntime(db, txn, params.gatewayId);
        if ("reason" in runtimeResult)
            return { kind: "rejected", reason: runtimeResult.reason };
        if (params.validateTarget) {
            const targetRejectReason = await params.validateTarget({
                txn,
                gatewayRef,
                assignmentRef,
                gateway: gatewayData,
                runtime: runtimeResult.runtime,
            });
            if (targetRejectReason)
                return { kind: "rejected", reason: targetRejectReason };
        }
        if (await preserveExistingAssignment(txn, assignmentRef, userRef, { ...params, mirrorPatch })) {
            applyAtomicWrites();
            return { kind: "assignment-preserved" };
        }
        txn.update(userRef, mirrorPatch);
        applyAtomicWrites();
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
