import fs from "node:fs";
import path from "node:path";
import { acquireSystemConfigSyncLeaseSync, } from "./system-config-mutation-lease.js";
const WORKSPACE_MUTATION_LOCK_NAME = "octogee.workspace-mutation.lock";
function gitMetadataDir(workspaceDir, explicitGitDir) {
    const gitDir = explicitGitDir ?? path.join(workspaceDir, ".git");
    let stat;
    try {
        stat = fs.statSync(gitDir);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new Error("workspace git metadata is missing");
        }
        throw error;
    }
    if (!stat.isDirectory())
        throw new Error("workspace git metadata is not a directory");
    return gitDir;
}
export function workspaceMutationLockPath(workspaceDir) {
    return path.join(gitMetadataDir(workspaceDir), WORKSPACE_MUTATION_LOCK_NAME);
}
export function acquireWorkspaceMutationLeaseSync(options) {
    const gitDir = gitMetadataDir(options.workspaceDir, options.gitDir);
    return acquireSystemConfigSyncLeaseSync({
        openclawDir: gitDir,
        lockName: WORKSPACE_MUTATION_LOCK_NAME,
        ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
        ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
    });
}
