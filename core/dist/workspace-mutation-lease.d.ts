import { type SystemConfigSyncLease } from "./system-config-mutation-lease.js";
export declare function projectMutationLeaseGitDir(workspaceDir: string, usersRoot: string): string | null;
export interface WorkspaceMutationLeaseOptions {
    workspaceDir: string;
    gitDir?: string;
    heartbeatMs?: number;
    staleAfterMs?: number;
    now?: () => number;
}
export declare function workspaceMutationLockPath(workspaceDir: string): string;
export declare function acquireWorkspaceMutationLeaseSync(options: WorkspaceMutationLeaseOptions): SystemConfigSyncLease | null;
