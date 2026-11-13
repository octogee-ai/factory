import type { ManagedChannelHost } from "./types.js";
export interface MattermostChannelHostConfig {
    baseUrl: string;
    adminToken: string;
    fetch?: typeof fetch;
    log?: (message: string) => void;
}
export interface MattermostChannelHost extends ManagedChannelHost {
    readonly provider: "mattermost";
}
export declare function createMattermostChannelHost(config: MattermostChannelHostConfig): MattermostChannelHost;
export declare function mattermostChannelHostFromEnv(): MattermostChannelHost;
