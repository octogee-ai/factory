export declare const WORKSPACE_VIBE_PRESETS: readonly ["office", "garage", "shop", "studio", "clubhouse", "crib"];
export type WorkspaceVibe = (typeof WORKSPACE_VIBE_PRESETS)[number];
export declare const DEFAULT_VIBE_NOUN = "Workspace";
export declare function isWorkspaceVibe(v: unknown): v is WorkspaceVibe;
export declare function titleCaseVibe(vibe: string | null | undefined): string;
export declare function computeWorkspaceDisplayName(params: {
    slug: string;
    firstName?: string | null;
    vibe?: string | null;
}): string;
export declare const WORKSPACE_CHANNEL_DISPLAY_NAMES: {
    readonly general: "General";
    readonly admin: "Admin";
    readonly coach: "Coach";
};
export type WorkspaceChannelKind = keyof typeof WORKSPACE_CHANNEL_DISPLAY_NAMES;
export declare function computeProjectChannelDisplayName(params: {
    projectName: string;
    channelName: string;
}): string;
export declare const TYPING_PHRASES_BY_VIBE: Record<WorkspaceVibe, readonly string[]>;
export declare const DEFAULT_TYPING_PHRASES: readonly string[];
