import { isValidNewGatewayId } from "./glm.js";
import { USERNAME_RE } from "./identity.js";
const SHORT_SLUG_LENGTH = 13;
const DISPOSABLE_SLUG_LENGTH = 19;
function stableHash(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
export function builderGatewayIdForSlug(slug) {
    if (!USERNAME_RE.test(slug)) {
        throw new Error("invalid Builder slug");
    }
    const full = `builder-${slug}`;
    if (isValidNewGatewayId(full))
        return full;
    let shortSlug = slug.slice(0, SHORT_SLUG_LENGTH);
    while (shortSlug.endsWith("-"))
        shortSlug = shortSlug.slice(0, -1);
    const shortened = `builder-${shortSlug}-${stableHash(slug)}`;
    if (!isValidNewGatewayId(shortened)) {
        throw new Error("Builder slug cannot produce a valid gateway id");
    }
    return shortened;
}
export function disposableBuilderGatewayId(slug, generation, leaseId) {
    if (!USERNAME_RE.test(slug))
        throw new Error("invalid Builder slug");
    if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error("invalid Builder runtime generation");
    }
    if (leaseId.length === 0)
        throw new Error("invalid Builder runtime lease");
    let shortSlug = slug.slice(0, DISPOSABLE_SLUG_LENGTH);
    while (shortSlug.endsWith("-"))
        shortSlug = shortSlug.slice(0, -1);
    const id = `run-${shortSlug}-${stableHash(`${slug}:${generation}:${leaseId}`)}`;
    if (!isValidNewGatewayId(id)) {
        throw new Error("Builder runtime cannot produce a valid gateway id");
    }
    return id;
}
