const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const POD_REPLACEMENT_RECENT_WINDOW_MS = 7 * DAY_MS;
export const POD_REPLACEMENT_WARNING_THRESHOLD_24H = 3;
export const POD_REPLACEMENT_MAX_RETAINED = 64;
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isEpochMs(value) {
    return typeof value === "number" && Number.isFinite(value);
}
export function isGatewayPodReplacements(value) {
    if (!isRecord(value))
        return false;
    return (Array.isArray(value.recentAt) &&
        value.recentAt.every(isEpochMs) &&
        (value.lastAt === null || isEpochMs(value.lastAt)) &&
        (value.lastPodUid === null || typeof value.lastPodUid === "string") &&
        typeof value.total === "number" &&
        Number.isSafeInteger(value.total) &&
        value.total >= 0);
}
// A replacement stamped ahead of `now` cannot be counted against a window that
// ends at `now`; clock skew must not inflate the indicator.
function countWithin(recentAt, now, windowMs) {
    return recentAt.filter((at) => at <= now && now - at < windowMs).length;
}
export function summarizeGatewayPodReplacements(value, now) {
    if (!value) {
        return { count24h: 0, count7d: 0, lastAt: null, lastPodUid: null, total: 0, warn: false };
    }
    const count24h = countWithin(value.recentAt, now, DAY_MS);
    return {
        count24h,
        count7d: countWithin(value.recentAt, now, POD_REPLACEMENT_RECENT_WINDOW_MS),
        lastAt: value.lastAt,
        lastPodUid: value.lastPodUid,
        total: value.total,
        warn: count24h >= POD_REPLACEMENT_WARNING_THRESHOLD_24H,
    };
}
export function pruneGatewayPodReplacementWindow(recentAt, now) {
    return recentAt
        .filter((at) => at <= now && now - at < POD_REPLACEMENT_RECENT_WINDOW_MS)
        .sort((left, right) => left - right)
        .slice(-POD_REPLACEMENT_MAX_RETAINED);
}
