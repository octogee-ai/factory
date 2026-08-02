export declare const CHANNEL_NAME_MAX_LENGTH = 64;
export declare const USERNAME_MIN_LENGTH = 2;
export declare const USERNAME_MAX_LENGTH = 24;
export declare const PROJECT_ID_MIN_LENGTH = 1;
export declare const PROJECT_ID_MAX_LENGTH = 16;
export declare const CUSTOM_CHANNEL_MIN_LENGTH = 1;
export declare const CUSTOM_CHANNEL_MAX_LENGTH = 17;
export declare const USERNAME_RE: RegExp;
export declare const PROJECT_ID_RE: RegExp;
export declare const CUSTOM_CHANNEL_RE: RegExp;
export declare const PROJECT_DISCRIMINATOR: 'proj';
export declare const COMMUNITY_PREFIX: 'community';
export declare const RESERVED_WORKSPACE_CHANNELS: readonly ['general', 'coach', 'admin'];
export declare const MM_SYSTEM_CHANNELS: ReadonlySet<string>;
export declare const RESERVED_USERNAMES: ReadonlySet<string>;
export declare const RESERVED_MATTERMOST_TEAM_PREFIXES: readonly string[];
export declare function isValidUsername(name: unknown): name is string;
export declare function usernameValidationError(name: unknown): string | null;
export declare function isValidProjectId(id: unknown): id is string;
export declare function isValidCustomChannelName(name: unknown): name is string;
export declare function workspaceGeneralChannelName(username: string): string;
export declare function workspaceCoachChannelName(username: string): string;
export declare function workspaceAdminChannelName(username: string): string;
export declare function workspaceCustomChannelName(username: string, custom: string): string;
export declare function projectGeneralChannelName(username: string, project: string): string;
export declare function projectChannelName(username: string, project: string, channel: string): string;
export declare function isMmSystemChannel(name: string): boolean;
export declare const AGENT_ID_PREFIX: 'octogee-';
export declare const AGENT_ID_SUFFIX: '-coach';
export declare function workspaceCoachAgentId(username: string): string;
export declare function projectAgentId(username: string, project: string): string;
export declare function workspaceCoachMmUsername(username: string): string;
export declare function projectAgentMmUsername(username: string, project: string): string;
export type ParsedAgentId = {
    kind: 'coach';
    username: string;
} | {
    kind: 'project';
    username: string;
    project: string;
} | {
    kind: 'unknown';
    id: string;
};
export declare function parseAgentId(id: string): ParsedAgentId;
export declare function isCommunityChannel(name: string): boolean;
export type ParsedChannel = {
    kind: 'workspace';
    username: string;
    channel: string;
    reserved: boolean;
} | {
    kind: 'project';
    username: string;
    project: string;
    channel: string;
} | {
    kind: 'community';
    name: string;
} | {
    kind: 'system';
    name: string;
} | {
    kind: 'foreign';
    name: string;
} | {
    kind: 'unknown';
    name: string;
};
export declare function parseChannelName(name: string, username: string): ParsedChannel;
export declare function attributeChannelToUsername(name: string, usernames: readonly string[]): string | null;
export declare function deriveJoinedUsernames(channels: ReadonlyArray<{
    name: string;
    type: string;
}>, ownUsername: string | null): string[];
export declare function deriveContactedUsernames(channels: ReadonlyArray<{
    name: string;
    type: string;
}>, ownUsername: string | null): string[];
