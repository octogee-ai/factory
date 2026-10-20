import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import { GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";
import { GATEWAY_RELEASES_SUBCOLLECTION, isGatewayDesiredDoc, isReleasePayload, releasePayloadHash, } from "@octogee/shared/types/gateway-releases";
import { projectGatewayMutableConfigForGateway, } from "@octogee/shared/types/gateway-mutable-config";
import { gatewayArtifactFromReleasePayload } from "./gateway-live-release.js";
import { assertGatewayRuntimeMutationUnfenced, GatewayRetirementConflictError } from "./gateway-retirement-claim.js";
export function asDurableGatewayRoot(data, gatewayId) {
    if (!isGatewayDesiredDoc(data) || data.gatewayId !== gatewayId)
        return null;
    return projectGatewayMutableConfigForGateway(data, gatewayId);
}
export class StaleGatewayReleaseError extends Error {
    gatewayId;
    expectedRelease;
    actualRelease;
    constructor(gatewayId, expectedRelease, actualRelease) {
        super(`gateway ${gatewayId} changed while this release was being cut ` +
            `(expected ${expectedRelease}, found ${actualRelease})`);
        this.gatewayId = gatewayId;
        this.expectedRelease = expectedRelease;
        this.actualRelease = actualRelease;
    }
}
export class InvalidGatewayRootError extends Error {
    gatewayId;
    constructor(gatewayId) {
        super(`gateway ${gatewayId} durable root is invalid`);
        this.gatewayId = gatewayId;
    }
}
export class GatewayOwnerChangeError extends Error {
    gatewayId;
    field;
    constructor(gatewayId, field) {
        super(`gateway ${gatewayId} ${field} is already bound; a release cannot change it`);
        this.gatewayId = gatewayId;
        this.field = field;
    }
}
function assertOwnerUnchanged(current, caller) {
    for (const field of ["ownerUid", "builderSlug"]) {
        if (current[field] !== null && caller[field] !== current[field]) {
            throw new GatewayOwnerChangeError(current.gatewayId, field);
        }
    }
}
export function rolloutOperationInput(gatewayId, targetRelease, artifact) {
    return {
        gatewayId,
        targetRelease,
        imageTag: artifact.imageTag,
        imageRepository: artifact.imageRepository,
    };
}
async function currentRootForAppend(transaction, gatewayRef, args) {
    const snapshot = await transaction.get(gatewayRef);
    const current = asDurableGatewayRoot(snapshot.data(), args.gateway.gatewayId);
    if (!current)
        throw new InvalidGatewayRootError(args.gateway.gatewayId);
    assertOwnerUnchanged(current, args.gateway);
    if (current.desiredStatus === "retired" || current.retirementClaim != null) {
        throw new GatewayRetirementConflictError(`gateway ${args.gateway.gatewayId} has a current retirement claim`);
    }
    if (current.latestRelease !== args.gateway.latestRelease) {
        throw new StaleGatewayReleaseError(args.gateway.gatewayId, args.gateway.latestRelease, current.latestRelease);
    }
    return current;
}
async function assertReleaseIsNew(transaction, gatewayRef, gatewayId, release) {
    const releaseRef = gatewayRef.collection(GATEWAY_RELEASES_SUBCOLLECTION).doc(String(release));
    if (await transaction.get(releaseRef).then((snapshot) => snapshot.exists)) {
        throw new Error(`appendGatewayRelease: gateways/${gatewayId}/releases/${release} already exists — refusing to overwrite immutable history`);
    }
}
function releasePayloadFor(args) {
    const payload = args.payload ?? { ...args.artifact };
    if (!isReleasePayload(payload)) {
        throw new Error("appendGatewayRelease requires a valid immutable release payload");
    }
    return payload;
}
export async function appendGatewayRelease(db, args) {
    const gatewayRef = db.collection(GATEWAYS_COLLECTION).doc(args.gateway.gatewayId);
    const operationRef = db.collection(GLM_OPERATIONS_COLLECTION).doc();
    return db.runTransaction(async (transaction) => {
        const current = await currentRootForAppend(transaction, gatewayRef, args);
        await assertGatewayRuntimeMutationUnfenced(db, transaction, args.gateway.gatewayId);
        const release = current.latestRelease + 1;
        const releaseRef = gatewayRef.collection(GATEWAY_RELEASES_SUBCOLLECTION).doc(String(release));
        await assertReleaseIsNew(transaction, gatewayRef, args.gateway.gatewayId, release);
        const payload = releasePayloadFor(args);
        const artifact = gatewayArtifactFromReleasePayload(payload);
        const releaseDoc = {
            gatewayId: args.gateway.gatewayId,
            release,
            createdAt: args.now,
            createdBy: args.createdBy,
            sourceRelease: args.sourceRelease,
            note: args.note,
            payloadHash: releasePayloadHash(payload),
            payload,
        };
        transaction.set(releaseRef, releaseDoc);
        transaction.update(gatewayRef, {
            latestRelease: release,
            updatedAt: args.now,
            updatedBy: args.createdBy,
        });
        transaction.set(operationRef, {
            kind: "rollout",
            status: "pending",
            createdBy: args.createdBy,
            ...(args.origin ? { origin: args.origin } : {}),
            createdAt: args.now,
            startedAt: null,
            completedAt: null,
            input: rolloutOperationInput(args.gateway.gatewayId, release, artifact),
            steps: [],
            gatewayId: args.gateway.gatewayId,
        });
        return { release, operationId: operationRef.id };
    });
}
