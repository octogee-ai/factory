import { GATEWAY_CONFIG_SCHEMA_VERSION, effectiveGatewayServiceAccountNameForGateway, isBareGatewayId, isGatewayMutableConfig, isGatewayMutableConfigForGateway, projectGatewayMutableConfigForGateway, } from "@octogee/shared/types/gateway-mutable-config";
import { isGatewayRuntimeDoc, isReleasePayload, projectGatewayDesiredRootForGateway, releasePayloadHash, upgradeReleasePayloadSchema, } from "@octogee/shared/types/gateway-releases";
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
export function configuredUserBootstrapAllowed(value, input) {
    return eligibleConfiguredIsolatedGateway(value, input) !== null;
}
function eligibleConfiguredIsolatedGateway(value, input) {
    const gateway = projectGatewayDesiredRootForGateway(value, input.gatewayId);
    if (gateway === null)
        return null;
    if (!podBelongsToGateway(input.gatewayId, input.podName) ||
        gateway.desiredStatus !== "running" ||
        gateway.retireAfter != null ||
        gateway.retirementClaim != null ||
        gateway.gatewayClass === "shared" ||
        gateway.builderSlug !== input.slug) {
        return null;
    }
    return gateway;
}
export function configuredUserCredentialBootstrapAllowed(value, input) {
    const gateway = eligibleConfiguredIsolatedGateway(value, input);
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
export async function writeInitialGatewayReleaseInTransaction(transaction, args) {
    const { gatewayDoc, releaseDoc } = initialGatewayReleaseDocuments(args);
    const [existing, releaseExisting] = await Promise.all([
        transaction.gateways.roots.get(args.gatewayId),
        transaction.gateways.releases.get(args.gatewayId, 1),
    ]);
    if (existing !== null || releaseExisting !== null) {
        throw new InitialGatewayReleaseConflictError(args.gatewayId);
    }
    await transaction.gateways.roots.create(gatewayDoc);
    await transaction.gateways.releases.createInitial(releaseDoc);
}
export async function writeInitialGatewayReleaseInStore(store, args, beforeCommit) {
    await store.transaction({ label: "gateway-release.initial" }, async (transaction) => {
        await writeInitialGatewayReleaseInTransaction(transaction, args);
        await beforeCommit?.();
    });
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function gatewayArtifactFromReleasePayload(payload) {
    return {
        imageRepository: payload.imageRepository,
        imageTag: payload.imageTag,
        ...(payload.openclawSourceSha === undefined
            ? {}
            : { openclawSourceSha: payload.openclawSourceSha }),
        ...(payload.profileImages === undefined
            ? {}
            : { profileImages: payload.profileImages }),
        ...(payload.gatewayEdgeImage === undefined
            ? {}
            : { gatewayEdgeImage: payload.gatewayEdgeImage }),
    };
}
function isGatewayArtifact(value) {
    return isReleasePayload(value);
}
function isReleaseNumber(release) {
    return typeof release === "number" && Number.isInteger(release) && release >= 1;
}
export async function readGatewayArtifactInStore(state, gatewayId, release) {
    if (!isBareGatewayId(gatewayId) || !isReleaseNumber(release))
        return null;
    return artifactFromStoredRelease(await state.gateways.releases.get(gatewayId, release), gatewayId, release);
}
function artifactFromStoredRelease(releaseData, gatewayId, release) {
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
export async function readGatewayRuntimeDoc(state, gateway) {
    const stored = await state.fleetRegistry.get(gateway.gatewayId);
    if (stored === null)
        return undefined;
    const { revision: _revision, ...record } = stored;
    return { docKind: "runtime", ...record };
}
export function gatewayRuntimeHeartbeatOf(runtime, gateway) {
    if (!isGatewayRuntimeDoc(runtime) ||
        runtime.gatewayId !== gateway.gatewayId ||
        runtime.lifecycle !== "serving" ||
        !isRecord(runtime.heartbeat)) {
        return null;
    }
    return runtime.heartbeat;
}
export async function readGatewayRuntimeHeartbeat(state, gateway) {
    return gatewayRuntimeHeartbeatOf(await readGatewayRuntimeDoc(state, gateway), gateway);
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
        builderAccess: config.builderAccess,
        ownerUid: config.ownerUid,
        builderSlug: config.builderSlug,
        modelBrokerLimits: config.modelBrokerLimits,
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
export async function readGatewayAuthorizationInStore(state, gatewayId) {
    if (!isBareGatewayId(gatewayId))
        return null;
    const stored = await state.gateways.roots.get(gatewayId);
    if (stored === null)
        return null;
    const { revision: _revision, ...root } = stored;
    return gatewayAuthorizationFromRootDocument(root, gatewayId);
}
export async function readServingGatewayAuthorization(state, gatewayId) {
    const authorization = await readGatewayAuthorizationInStore(state, gatewayId);
    if (!authorization || authorization.gateway.desiredStatus !== "running")
        return null;
    const runtime = await state.fleetRegistry.get(gatewayId);
    return runtime?.lifecycle === "serving" ? authorization : null;
}
