import type { GitHostNaming, ManagedGitHost } from "./types.js";
export interface GiteaGitHostConfig {
    apiBaseUrl: string;
    token: () => string;
    fetch?: typeof fetch;
    log?: (message: string) => void;
}
export interface GiteaGitHost extends ManagedGitHost {
    readonly provider: "gitea";
    primaryKey(workspaceSlug: string): Promise<string | null>;
}
export declare const giteaNaming: GitHostNaming;
export declare function createGiteaGitHost(config: GiteaGitHostConfig): GiteaGitHost;
