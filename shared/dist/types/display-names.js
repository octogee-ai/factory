export const WORKSPACE_VIBE_PRESETS = [
    "office",
    "garage",
    "shop",
    "studio",
    "clubhouse",
    "crib",
];
export const DEFAULT_VIBE_NOUN = "Workspace";
export function isWorkspaceVibe(v) {
    return (typeof v === "string" &&
        WORKSPACE_VIBE_PRESETS.includes(v));
}
export function titleCaseVibe(vibe) {
    if (!isWorkspaceVibe(vibe))
        return DEFAULT_VIBE_NOUN;
    return vibe.charAt(0).toUpperCase() + vibe.slice(1);
}
export function computeWorkspaceDisplayName(params) {
    const { slug, firstName, vibe } = params;
    const trimmedSlug = typeof slug === "string" ? slug.trim() : "";
    if (trimmedSlug.length === 0) {
        throw new Error("computeWorkspaceDisplayName: slug is required");
    }
    const noun = isWorkspaceVibe(vibe) ? titleCaseVibe(vibe) : DEFAULT_VIBE_NOUN;
    const trimmedFirstName = typeof firstName === "string" ? firstName.trim() : "";
    const owner = trimmedFirstName.length > 0 ? trimmedFirstName : trimmedSlug;
    return `${owner}'s ${noun}`;
}
export const WORKSPACE_CHANNEL_DISPLAY_NAMES = {
    general: "General",
    admin: "Admin",
    coach: "Coach",
};
export function computeProjectChannelDisplayName(params) {
    const trimmedProject = typeof params.projectName === "string" ? params.projectName.trim() : "";
    const trimmedChannel = typeof params.channelName === "string" ? params.channelName.trim() : "";
    if (trimmedProject.length === 0) {
        throw new Error("computeProjectChannelDisplayName: projectName is required");
    }
    if (trimmedChannel.length === 0) {
        throw new Error("computeProjectChannelDisplayName: channelName is required");
    }
    return `${trimmedProject} ${trimmedChannel}`;
}
export const TYPING_PHRASES_BY_VIBE = {
    office: ["analyzing", "crunching the numbers", "strategizing", "briefing"],
    garage: ["tinkering", "soldering", "hacking", "duct-taping"],
    shop: ["measuring twice", "sawing", "sanding", "finishing"],
    studio: ["drafting", "sketching", "composing", "dreaming up something"],
    clubhouse: ["rallying the crew", "plotting", "kicking ideas around", "vibing"],
    crib: ["chilling", "noodling", "vibing", "kicking ideas around"],
};
export const DEFAULT_TYPING_PHRASES = [
    "philosophizing",
    "vibing",
    "Clauding",
    "dreaming up something",
    "cooking",
];
