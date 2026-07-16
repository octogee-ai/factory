import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION } from "@octogee/shared/types/glm";
import { GATEWAY_CONFIG_SCHEMA_VERSION, effectiveGatewayServiceAccountNameForGateway, isBareGatewayId, isGatewayMutableConfig, isGatewayMutableConfigForGateway, } from "@octogee/shared/types/gateway-mutable-config";
import { GATEWAY_RELEASES_SUBCOLLECTION, isGatewayDesiredDoc, isReleasePayload, isRevisionRealizationDoc, revisionIdForRelease, } from "@octogee/shared/types/gateway-releases";
export { GATEWAY_CONFIG_SCHEMA_VERSION, effectiveGatewayServiceAccountNameForGateway, isBareGatewayId, isGatewayMutableConfig, isGatewayMutableConfigForGateway, };
export function gatewayRevisionIdFromPodName(gatewayId, podName) {
    if (!podName)
        return null;
    const prefix = `octogee-gateway-${gatewayId}-r`;
    if (!podName.startsWith(prefix))
        return null;
    const suffix = podName.slice(prefix.length);
    const separator = suffix.indexOf("-");
    if (separator <= 0)
        return null;
    const release = suffix.slice(0, separator);
    const generatedSuffix = suffix.slice(separator + 1);
    if (!/^[1-9]\d*$/.test(release))
        return null;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(generatedSuffix))
        return null;
    return `${gatewayId}-r${release}`;
}
export function configuredBuilderBootstrapAllowed(value, input) {
    if (!isGatewayDesiredDoc(value) ||
        value.gatewayId !== input.gatewayId ||
        !isGatewayMutableConfigForGateway(value, input.gatewayId)) {
        return false;
    }
    const gateway = value;
    if (!input.revisionId ||
        gateway.desiredStatus !== "running" ||
        gateway.retireAfter != null ||
        gateway.retirementClaim != null ||
        gateway.gatewayClass === "shared" ||
        gateway.builderSlug !== input.slug) {
        return false;
    }
    if (gateway.roll) {
        return gateway.roll.status !== "failed" &&
            gateway.roll.targetRevisionId === input.revisionId;
    }
    return revisionIdForRelease(input.gatewayId, gateway.desiredRelease) === input.revisionId;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonicalGatewayRevision(gatewayId, revisionId, release) {
    if (typeof revisionId !== "string" ||
        typeof release !== "number" ||
        !Number.isInteger(release) ||
        release < 1 ||
        revisionId !== revisionIdForRelease(gatewayId, release)) {
        return null;
    }
    return { revisionId, release };
}
export function gatewayArtifactFromReleasePayload(payload) {
    return {
        imageRepository: payload.imageRepository,
        imageTag: payload.imageTag,
        ...(payload.gatewayEdgeImage === undefined
            ? {}
            : { gatewayEdgeImage: payload.gatewayEdgeImage }),
        ...(payload.testExperiment === undefined
            ? {}
            : { testExperiment: payload.testExperiment }),
    };
}
function isGatewayArtifact(value) {
    return isReleasePayload(value);
}
export async function readGatewayArtifact(db, gatewayId, release) {
    if (!isBareGatewayId(gatewayId))
        return null;
    if (typeof release !== "number" || !Number.isInteger(release) || release < 1)
        return null;
    const releaseSnap = await db
        .doc(`${GATEWAYS_COLLECTION}/${gatewayId}/${GATEWAY_RELEASES_SUBCOLLECTION}/${release}`)
        .get();
    const releaseData = releaseSnap.exists ? releaseSnap.data() : undefined;
    const payload = isRecord(releaseData) ? releaseData.payload : undefined;
    if (!isRecord(releaseData) ||
        releaseData.gatewayId !== gatewayId ||
        releaseData.release !== release ||
        !isGatewayArtifact(payload)) {
        return null;
    }
    return gatewayArtifactFromReleasePayload(payload);
}
export async function readGatewayLiveRevisionHeartbeat(db, gateway) {
    const live = canonicalGatewayRevision(gateway.gatewayId, gateway.liveRevisionId, gateway.liveRelease);
    if (!live)
        return null;
    const revisionSnap = await db.doc(`${GLM_GATEWAYS_COLLECTION}/${live.revisionId}`).get();
    const revision = revisionSnap.exists ? revisionSnap.data() : undefined;
    if (!isRevisionRealizationDoc(revision) ||
        revision.revisionId !== live.revisionId ||
        revision.gateway !== gateway.gatewayId ||
        revision.release !== live.release ||
        revision.lifecycle !== "serving" ||
        !isRecord(revision.heartbeat)) {
        return null;
    }
    return revision.heartbeat;
}
export function mergeGatewayConfigWithArtifact(config, artifact) {
    return {
        profile: config.profile,
        gatewayClass: config.gatewayClass,
        imageProfile: config.imageProfile,
        sizingTier: config.sizingTier,
        computeClass: config.computeClass,
        gcpProject: config.gcpProject,
        gatewayContainerSecurityContext: config.gatewayContainerSecurityContext,
        serviceAccountName: config.serviceAccountName,
        serviceAccount: config.serviceAccount,
        operatorAccess: config.operatorAccess,
        ownerUid: config.ownerUid,
        coOwnerUids: [...config.coOwnerUids],
        builderSlug: config.builderSlug,
        openclawOverrides: config.openclawOverrides,
        modelBrokerLimits: config.modelBrokerLimits,
        preemption: config.preemption,
        ...artifact,
    };
}
export function gatewayAuthorizationFromRootDocument(data, gatewayId) {
    if (!isBareGatewayId(gatewayId))
        return null;
    if (!isGatewayDesiredDoc(data) ||
        data.gatewayId !== gatewayId ||
        !isGatewayMutableConfigForGateway(data, gatewayId)) {
        return null;
    }
    return { kind: "durable", gateway: data, config: data };
}
export async function readGatewayAuthorization(db, gatewayId) {
    if (!isBareGatewayId(gatewayId))
        return null;
    const gatewaySnap = await db.doc(`${GATEWAYS_COLLECTION}/${gatewayId}`).get();
    const gatewayData = gatewaySnap.exists ? gatewaySnap.data() : undefined;
    return gatewaySnap.exists ? gatewayAuthorizationFromRootDocument(gatewayData, gatewayId) : null;
}
export async function readRevisionGatewayAuthorization(db, gatewayId, revisionId) {
    const gatewaySnap = await db.doc(`${GATEWAYS_COLLECTION}/${gatewayId}`).get();
    const gatewayData = gatewaySnap.exists ? gatewaySnap.data() : undefined;
    if (!gatewaySnap.exists)
        return null;
    const authorization = gatewayAuthorizationFromRootDocument(gatewayData, gatewayId);
    if (!authorization)
        return null;
    const live = canonicalGatewayRevision(authorization.gateway.gatewayId, authorization.gateway.liveRevisionId, authorization.gateway.liveRelease);
    const target = authorization.gateway.roll
        ? canonicalGatewayRevision(authorization.gateway.gatewayId, authorization.gateway.roll.targetRevisionId, authorization.gateway.roll.toRelease)
        : null;
    let expected = null;
    if (live?.revisionId === revisionId) {
        expected = live;
    }
    else if (target?.revisionId === revisionId) {
        expected = target;
    }
    if (!expected)
        return null;
    const revisionSnap = await db.doc(`${GLM_GATEWAYS_COLLECTION}/${revisionId}`).get();
    const revisionData = revisionSnap.exists ? revisionSnap.data() : undefined;
    if (!isRevisionRealizationDoc(revisionData) ||
        revisionData.revisionId !== revisionId ||
        revisionData.gateway !== gatewayId ||
        revisionData.release !== expected.release) {
        return null;
    }
    return authorization;
}
export async function readServingGatewayAuthorization(db, gatewayId) {
    const authorization = await readGatewayAuthorization(db, gatewayId);
    if (!authorization)
        return null;
    if (authorization.gateway.desiredStatus !== "running")
        return null;
    const live = canonicalGatewayRevision(authorization.gateway.gatewayId, authorization.gateway.liveRevisionId, authorization.gateway.liveRelease);
    if (!live)
        return null;
    const revisionSnap = await db.doc(`${GLM_GATEWAYS_COLLECTION}/${live.revisionId}`).get();
    const revisionData = revisionSnap.exists ? revisionSnap.data() : undefined;
    if (!isRevisionRealizationDoc(revisionData) ||
        revisionData.revisionId !== live.revisionId ||
        revisionData.gateway !== gatewayId ||
        revisionData.release !== live.release ||
        revisionData.lifecycle !== "serving") {
        return null;
    }
    return authorization;
}
