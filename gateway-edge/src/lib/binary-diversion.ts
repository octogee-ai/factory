import { readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { gitStatus } from "./workspace-git.js";
import { storeWorkspaceBlob, type WorkspaceBlobTarget } from "./workspace-blob.js";
import { getMimeType, getExtension } from "../routes/workspace/helpers.js";

/** git's own heuristic: a NUL byte anywhere in the first 8000 bytes. */
export const BINARY_SNIFF_BYTES = 8000;

/** Above this a blob is left alone and reported rather than read into memory. */
export const MAX_DIVERTED_BLOB_BYTES = 100 * 1024 * 1024;

const NEVER_DIVERT_PREFIXES = [".blobs/", ".files/", ".git/"];

export function looksBinary(sample: Buffer): boolean {
  return sample.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export function isDivertablePath(relativePath: string): boolean {
  if (relativePath.length === 0 || relativePath.startsWith("/")) return false;
  if (relativePath.split("/").includes("..")) return false;
  return !NEVER_DIVERT_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

export interface DivertedBlob {
  path: string;
  size: number;
}

export interface DivertBinariesResult {
  diverted: DivertedBlob[];
  failures: string[];
}

export interface DivertBinariesDeps {
  gitStatus: typeof gitStatus;
  storeWorkspaceBlob: typeof storeWorkspaceBlob;
}

const DEFAULT_DEPS: DivertBinariesDeps = { gitStatus, storeWorkspaceBlob };

/**
 * Text belongs in git; binaries belong in GCS, unversioned but backed up. Which
 * store a file lands in cannot depend on the caller picking the right endpoint,
 * so the commit path decides for anything the Agent or a chat drop wrote
 * straight into the worktree.
 *
 * Scoped to the commit's own change set rather than the tree, and the upload
 * happens here — gateway-edge holds GCS credentials on every gateway class,
 * whereas blob-sync is disabled by profile on Builder gateways and would leave
 * the file on an emptyDir that nothing uploads from.
 */
export async function divertWorktreeBinaries(
  customerDir: string,
  target: WorkspaceBlobTarget,
  deps: DivertBinariesDeps = DEFAULT_DEPS,
): Promise<DivertBinariesResult> {
  const status = await deps.gitStatus(customerDir);
  if (!status.ok) {
    return { diverted: [], failures: [`git status failed: ${status.error.code}`] };
  }

  const diverted: DivertedBlob[] = [];
  const failures: string[] = [];

  for (const entry of status.entries) {
    if (entry.change === "deleted" || !isDivertablePath(entry.path)) continue;
    const absolute = path.join(customerDir, entry.path);

    try {
      const stats = await stat(absolute);
      if (!stats.isFile()) continue;

      const contents = await readFile(absolute);
      if (!looksBinary(contents)) continue;

      if (stats.size > MAX_DIVERTED_BLOB_BYTES) {
        failures.push(`${entry.path}: ${stats.size} bytes exceeds the blob limit`);
        continue;
      }

      await deps.storeWorkspaceBlob(
        target,
        entry.path,
        contents,
        getMimeType(getExtension(entry.path)),
      );
      await unlink(absolute);
      diverted.push({ path: entry.path, size: stats.size });
    } catch (err) {
      failures.push(`${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { diverted, failures };
}
