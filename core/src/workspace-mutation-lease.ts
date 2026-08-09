import fs from "node:fs";
import path from "node:path";

import {
  acquireSystemConfigSyncLeaseSync,
  type SystemConfigSyncLease,
} from "./system-config-mutation-lease.js";

const WORKSPACE_MUTATION_LOCK_NAME = "octogee.workspace-mutation.lock";

export interface WorkspaceMutationLeaseOptions {
  workspaceDir: string;
  gitDir?: string;
  heartbeatMs?: number;
  staleAfterMs?: number;
  now?: () => number;
}

function gitMetadataDir(workspaceDir: string, explicitGitDir?: string): string {
  const gitDir = explicitGitDir ?? path.join(workspaceDir, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(gitDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("workspace git metadata is missing");
    }
    throw error;
  }
  if (!stat.isDirectory()) throw new Error("workspace git metadata is not a directory");
  return gitDir;
}

export function workspaceMutationLockPath(workspaceDir: string): string {
  return path.join(gitMetadataDir(workspaceDir), WORKSPACE_MUTATION_LOCK_NAME);
}

export function acquireWorkspaceMutationLeaseSync(
  options: WorkspaceMutationLeaseOptions,
): SystemConfigSyncLease | null {
  const gitDir = gitMetadataDir(options.workspaceDir, options.gitDir);
  return acquireSystemConfigSyncLeaseSync({
    openclawDir: gitDir,
    lockName: WORKSPACE_MUTATION_LOCK_NAME,
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
