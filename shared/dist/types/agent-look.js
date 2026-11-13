export const AGENT_LOOK_STYLES = ["octo", "blob", "droplet", "ghost", "star", "kit"];
const LOOK_COLOR = /^#[0-9a-f]{6}$/;
function isAgentLookStyle(value) {
    return typeof value === "string" && AGENT_LOOK_STYLES.includes(value);
}
function isAgentLookColor(value) {
    return typeof value === "string" && LOOK_COLOR.test(value);
}
export function parseAgentLook(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const { style, color } = value;
    return isAgentLookStyle(style) && isAgentLookColor(color) ? { style, color } : null;
}
