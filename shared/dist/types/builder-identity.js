import { isValidGatewayId } from "./glm.js";
import { isValidUsername } from "./identity.js";
export const BUILDER_IDENTITY_ROUTE = "/internal/fleet/builder-identity";
const UNAVAILABLE_REASONS = new Set(["retired", "retiring", "not-builder"]);
const OWNER_UID_MAX_LENGTH = 128;
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isBuilderOwnerUid(value) {
    return typeof value === "string" && value.length > 0 && value.length <= OWNER_UID_MAX_LENGTH &&
        value.trim() === value && !value.includes("/");
}
function isNullableLeaseId(value) {
    return value === null || (typeof value === "string" && value.length > 0);
}
function isNullableGeneration(value) {
    return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function claimedIdentityFields(value) {
    return isBuilderOwnerUid(value.ownerUid) && isValidUsername(value.builderSlug) &&
        isNullableLeaseId(value.leaseId) && isNullableGeneration(value.generation) &&
        (value.leaseId === null) === (value.generation === null);
}
export function parseBuilderIdentity(value, expectedGatewayId) {
    if (!isRecord(value) || value.gatewayId !== expectedGatewayId || !isValidGatewayId(value.gatewayId))
        return null;
    if (value.state === "standby")
        return { gatewayId: value.gatewayId, state: "standby" };
    if (value.state === "unavailable" && typeof value.reason === "string" && UNAVAILABLE_REASONS.has(value.reason)) {
        return { gatewayId: value.gatewayId, state: "unavailable", reason: value.reason };
    }
    if (value.state !== "claimed" || !claimedIdentityFields(value))
        return null;
    return {
        gatewayId: value.gatewayId,
        state: "claimed",
        ownerUid: value.ownerUid,
        builderSlug: value.builderSlug,
        leaseId: value.leaseId,
        generation: value.generation,
    };
}
export const BUILDER_CLAIM_FILE = "builder-claim.json";
function isTimestamp(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export function parseBuilderClaimRecord(value) {
    if (!isRecord(value) || value.schemaVersion !== 1 || !isValidGatewayId(value.gatewayId))
        return null;
    if (!claimedIdentityFields(value) || !isTimestamp(value.claimedAt))
        return null;
    if (value.overlayAppliedAt !== null && !isTimestamp(value.overlayAppliedAt))
        return null;
    return {
        schemaVersion: 1,
        gatewayId: value.gatewayId,
        ownerUid: value.ownerUid,
        builderSlug: value.builderSlug,
        leaseId: value.leaseId,
        generation: value.generation,
        claimedAt: value.claimedAt,
        overlayAppliedAt: value.overlayAppliedAt,
    };
}
export function builderClaimFromIdentity(identity, claimedAt) {
    return {
        schemaVersion: 1,
        gatewayId: identity.gatewayId,
        ownerUid: identity.ownerUid,
        builderSlug: identity.builderSlug,
        leaseId: identity.leaseId,
        generation: identity.generation,
        claimedAt,
        overlayAppliedAt: null,
    };
}
export function sameBuilderOwner(left, right) {
    return left.gatewayId === right.gatewayId && left.ownerUid === right.ownerUid &&
        left.builderSlug === right.builderSlug;
}
