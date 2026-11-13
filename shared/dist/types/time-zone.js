export const IANA_TIME_ZONE_PATTERN = "^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$";
export const IANA_TIME_ZONE_MAX_LENGTH = 64;
const IANA_TIME_ZONE_RE = new RegExp(IANA_TIME_ZONE_PATTERN, "u");
function knownToIntl(zone) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
    }
    catch {
        return false;
    }
}
export function parseTimeZone(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > IANA_TIME_ZONE_MAX_LENGTH)
        return null;
    if (!IANA_TIME_ZONE_RE.test(value))
        return null;
    return knownToIntl(value) ? value : null;
}
