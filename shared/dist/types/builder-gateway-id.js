import { isValidNewGatewayId } from "./glm.js";
import { USERNAME_RE } from "./identity.js";
const SHORT_SLUG_LENGTH = 13;
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
