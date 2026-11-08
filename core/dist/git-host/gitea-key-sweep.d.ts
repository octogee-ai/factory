import type { GitKeySweepInput, GitKeySweepResult, GitKeySweepState } from "./types.js";
export declare const GITEA_PAGE_SIZE = 50;
export interface GiteaPublicKeyRecord {
    id: number;
    title: string;
    key: string;
    createdAt: number | null;
}
export interface GiteaKeyAdmin {
    listUsernames(page: number): Promise<string[]>;
    listUserKeys(username: string, page: number): Promise<GiteaPublicKeyRecord[]>;
    deleteUserKey(username: string, keyId: number): Promise<boolean>;
}
export interface GiteaKeySweepDeps extends GitKeySweepInput {
    gitea: GiteaKeyAdmin;
}
export declare function runGiteaKeySweep(deps: GiteaKeySweepDeps, state: GitKeySweepState): Promise<GitKeySweepResult>;
export interface GiteaKeyAdminClientDeps {
    apiUrl: string;
    token: string;
    fetchImpl?: typeof fetch;
}
export declare function createGiteaKeyAdminClient(deps: GiteaKeyAdminClientDeps): GiteaKeyAdmin;
