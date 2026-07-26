import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION } from "@octogee/shared/types/glm";
import { GATEWAY_CONFIG_SCHEMA_VERSION, effectiveGatewayServiceAccountNameForGateway, isBareGatewayId, isGatewayMutableConfig, isGatewayMutableConfigForGateway, projectGatewayMutableConfigForGateway, } from "@octogee/shared/types/gateway-mutable-config";
import { GATEWAY_RELEASES_SUBCOLLECTION, isGatewayRuntimeDoc, isReleasePayload, projectGatewayDesiredRootForGateway, releasePayloadHash, upgradeReleasePayloadSchema, } from "@octogee/shared/types/gateway-releases";
export { GATEWAY_CONFIG_SCHEMA_VERSION, effectiveGatewayServiceAccountNameForGateway, isBareGatewayId, isGatewayMutableConfig, isGatewayMutableConfigForGateway, projectGatewayMutableConfigForGateway, };
// A gateway's pods are named octogee-gateway-<id>-<replicaset>-<pod> by the
// stable-name Deployment. Pod identity binds to the gateway alone — never to a
// release or lifecycle state (GATEWAY-SIMPLE-ROLL-SPEC identity-pure boot).
export function podBelongsToGateway(gatewayId, podName) {
    if (!podName)
        return false;
    const prefix = `octogee-gateway-${gatewayId}-`;
    if (!podName.startsWith(prefix))
        return false;
    const suffix = podName.slice(prefix.length);
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(suffix);
}
export function configuredBuilderBootstrapAllowed(value, input) {
    return eligibleConfiguredBuilderGateway(value, input) !== null;
}
function eligibleConfiguredBuilderGateway(value, input) {
    const gateway = projectGatewayDesiredRootForGateway(value, input.gatewayId);
    if (gateway === null)
        return null;
    if (!podBelongsToGateway(input.gatewayId, input.podName) ||
        gateway.gatewayClass === "shared" ||
        gateway.builderSlug !== input.slug) {
        return null;
    }
    return gateway;
}
export function configuredBuilderCredentialBootstrapAllowed(value, input) {
    const gateway = eligibleConfiguredBuilderGateway(value, input);
    return gateway !== null && gateway.ownerUid === input.uid;
}
export function initialGatewayReleaseDocuments(args) {
    const gatewayDoc = {
        gatewayId: args.gatewayId,
        createdAt: args.now,
        createdBy: args.createdBy,
        updatedAt: args.now,
        updatedBy: args.createdBy,
        latestRelease: 1,
        desiredRelease: 1,
        liveRelease: null,
        desiredStatus: args.desiredStatus,
        ...args.config,
    };
    const payload = { ...args.artifact };
    const releaseDoc = {
        gatewayId: args.gatewayId,
        release: 1,
        createdAt: args.now,
        createdBy: args.createdBy,
        sourceRelease: null,
        note: null,
        payloadHash: releasePayloadHash(payload),
        payload,
    };
    return { gatewayDoc, releaseDoc };
}
export class InitialGatewayReleaseConflictError extends Error {
    gatewayId;
    constructor(gatewayId) {
        super(`gateway ${gatewayId} already exists`);
        this.gatewayId = gatewayId;
    }
}
export async function writeInitialGatewayRelease(db, args) {
    const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(args.gatewayId);
    const releaseRef = gatewayRef
        .collection(GATEWAY_RELEASES_SUBCOLLECTION)
        .doc("1");
    const { gatewayDoc, releaseDoc } = initialGatewayReleaseDocuments(args);
    await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(gatewayRef);
        const releaseExisting = await transaction.get(releaseRef);
        await args.validateAdditional?.(transaction);
        if (existing.exists || releaseExisting.exists) {
            throw new InitialGatewayReleaseConflictError(args.gatewayId);
        }
        transaction.set(gatewayRef, gatewayDoc, { merge: true });
        transaction.set(releaseRef, releaseDoc);
        args.writeAdditional?.(transaction);
    });
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function gatewayArtifactFromReleasePayload(payload) {
    return {
        imageRepository: payload.imageRepository,
        imageTag: payload.imageTag,
        ...(payload.profileImages === undefined
            ? {}
            : { profileImages: payload.profileImages }),
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
    let artifact = isGatewayArtifact(payload) ? payload : null;
    if (artifact === null) {
        const upgrade = upgradeReleasePayloadSchema(payload, isRecord(releaseData) ? releaseData.payloadHash : undefined);
        if (upgrade.status === "upgraded")
            artifact = upgrade.payload;
    }
    if (!isRecord(releaseData) ||
        releaseData.gatewayId !== gatewayId ||
        releaseData.release !== release ||
        artifact === null) {
        return null;
    }
    return gatewayArtifactFromReleasePayload(artifact);
}
export async function readGatewayRuntimeHeartbeat(db, gateway) {
    const runtimeSnap = await db
        .doc(`${GLM_GATEWAYS_COLLECTION}/${gateway.gatewayId}`)
        .get();
    const runtime = runtimeSnap.exists ? runtimeSnap.data() : undefined;
    if (!isGatewayRuntimeDoc(runtime) ||
        runtime.gatewayId !== gateway.gatewayId ||
        runtime.lifecycle !== "serving" ||
        !isRecord(runtime.heartbeat)) {
        return null;
    }
    return runtime.heartbeat;
}
export function mergeGatewayConfigWithArtifact(config, artifact) {
    return {
        profile: config.profile,
        gatewayClass: config.gatewayClass,
        imageProfile: config.imageProfile,
        sizingTier: config.sizingTier,
        gcpProject: config.gcpProject,
        gatewayContainerSecurityContext: config.gatewayContainerSecurityContext,
        serviceAccountName: config.serviceAccountName,
        serviceAccount: config.serviceAccount,
        operatorAccess: config.operatorAccess,
        ownerUid: config.ownerUid,
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
    const gateway = projectGatewayDesiredRootForGateway(data, gatewayId);
    if (gateway === null)
        return null;
    return { kind: "durable", gateway, config: gateway };
}
export async function readGatewayAuthorization(db, gatewayId) {
    if (!isBareGatewayId(gatewayId))
        return null;
    const gatewaySnap = await db.doc(`${GATEWAYS_COLLECTION}/${gatewayId}`).get();
    const gatewayData = gatewaySnap.exists ? gatewaySnap.data() : undefined;
    return gatewaySnap.exists ? gatewayAuthorizationFromRootDocument(gatewayData, gatewayId) : null;
}
export async function readServingGatewayAuthorization(db, gatewayId) {
    const authorization = await readGatewayAuthorization(db, gatewayId);
    if (!authorization)
        return null;
    if (authorization.gateway.desiredStatus !== "running")
        return null;
    const runtimeSnap = await db.doc(`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`).get();
    const runtimeData = runtimeSnap.exists ? runtimeSnap.data() : undefined;
    if (!isGatewayRuntimeDoc(runtimeData) ||
        runtimeData.gatewayId !== gatewayId ||
        runtimeData.lifecycle !== "serving") {
        return null;
    }
    return authorization;
}
