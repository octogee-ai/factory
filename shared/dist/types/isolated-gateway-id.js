import { isValidNewGatewayId } from "./glm.js";
import { USERNAME_RE } from "./identity.js";
import { SIZING_TIERS } from "./sizing.js";
const SHORT_SLUG_LENGTH = 13;
const DISPOSABLE_SLUG_LENGTH = 20;
function stableHash(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
export function isolatedGatewayIdForSlug(slug) {
    if (!USERNAME_RE.test(slug)) {
        throw new Error("invalid user slug");
    }
    const full = `builder-${slug}`;
    if (isValidNewGatewayId(full))
        return full;
    let shortSlug = slug.slice(0, SHORT_SLUG_LENGTH);
    while (shortSlug.endsWith("-"))
        shortSlug = shortSlug.slice(0, -1);
    const shortened = `builder-${shortSlug}-${stableHash(slug)}`;
    if (!isValidNewGatewayId(shortened)) {
        throw new Error("User slug cannot produce a valid gateway id");
    }
    return shortened;
}
export function isolatedGatewayId(slug, generation, leaseId, sizingTier) {
    if (!USERNAME_RE.test(slug))
        throw new Error("invalid user slug");
    if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error("invalid isolated runtime generation");
    }
    if (leaseId.length === 0)
        throw new Error("invalid isolated runtime lease");
    if (!SIZING_TIERS.includes(sizingTier)) {
        throw new Error("invalid isolated runtime sizing tier");
    }
    let shortSlug = slug.slice(0, DISPOSABLE_SLUG_LENGTH);
    while (shortSlug.endsWith("-"))
        shortSlug = shortSlug.slice(0, -1);
    const runtimeIdentity = `${slug}:${generation}:${leaseId}`;
    const id = `${shortSlug}-${sizingTier}-${stableHash(runtimeIdentity)}`;
    if (!isValidNewGatewayId(id)) {
        throw new Error("Isolated runtime cannot produce a valid gateway id");
    }
    return id;
}
