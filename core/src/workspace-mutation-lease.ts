import fs from "node:fs";
import path from "node:path";

import {
  acquireSystemConfigSyncLeaseSync,
  type SystemConfigSyncLease,
} from "./system-config-mutation-lease.js";

const WORKSPACE_MUTATION_LOCK_NAME = "octogee.workspace-mutation.lock";

export function projectMutationLeaseGitDir(workspaceDir: string, usersRoot: string): string | null {
  const parts = path.relative(path.resolve(usersRoot), path.resolve(workspaceDir)).split(path.sep);
  if (parts.length !== 3 || parts[1] !== "projects" || ![parts[0], parts[2]].every(part => /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(part))) return null;
  const lockDir = path.join(path.dirname(usersRoot), "git-source-switch-locks", parts[0], `${parts[2]}.git`);
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  return lockDir;
}

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
