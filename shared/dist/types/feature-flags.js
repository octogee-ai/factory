export const FEATURE_FLAG_KEYS = [
    "release-openclaw-dashboard",
    "release-agent-import",
    "release-agent-export",
    "release-builder-gateway",
    "release-obsidian-connection",
];
export const FEATURE_FLAGS = {
    "release-openclaw-dashboard": { userVisible: true },
    "release-agent-import": { userVisible: true },
    "release-agent-export": { userVisible: true },
    "release-builder-gateway": { userVisible: true },
    "release-obsidian-connection": { userVisible: true },
};
export const USER_VISIBLE_FEATURE_FLAG_KEYS = FEATURE_FLAG_KEYS.filter((key) => FEATURE_FLAGS[key].userVisible);
export function isFeatureFlagKey(value) {
    return typeof value === "string" && FEATURE_FLAG_KEYS.includes(value);
}
