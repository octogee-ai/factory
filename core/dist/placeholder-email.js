export const DEFAULT_PLACEHOLDER_EMAIL_DOMAIN = "users.invalid";
const DOMAIN_SLOT = Symbol.for("platform.placeholderEmailDomain");
const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_NAME = new RegExp(`^${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+$`);
export function installPlaceholderEmailDomain(domain) {
    if (!DOMAIN_NAME.test(domain))
        throw new Error(`not a placeholder email domain: ${JSON.stringify(domain)}`);
    globalThis[DOMAIN_SLOT] = domain;
}
function placeholderEmailDomain() {
    return globalThis[DOMAIN_SLOT] ?? DEFAULT_PLACEHOLDER_EMAIL_DOMAIN;
}
export function placeholderEmail(localPart) {
    return `${localPart}@${placeholderEmailDomain()}`;
}
export function isPlaceholderEmail(email) {
    return email.endsWith(`@${placeholderEmailDomain()}`);
}
