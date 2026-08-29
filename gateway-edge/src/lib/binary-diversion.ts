import { lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { gitStatus } from "./workspace-git.js";
import { storeWorkspaceBlob, type WorkspaceBlobTarget } from "./workspace-blob.js";
import { getMimeType, getExtension } from "../routes/workspace/helpers.js";

export const BINARY_SNIFF_BYTES = 8000;

export const MAX_DIVERTED_BLOB_BYTES = 100 * 1024 * 1024;

const NEVER_DIVERT_PREFIXES = [".blobs/", ".files/", ".git/"];

export function looksBinary(sample: Buffer): boolean {
  return sample.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

async function sniffLooksBinary(absolutePath: string): Promise<boolean> {
  const handle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return looksBinary(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
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
  failedPaths: string[];
}

export interface DivertBinariesDeps {
  gitStatus: typeof gitStatus;
  storeWorkspaceBlob: typeof storeWorkspaceBlob;
}

const DEFAULT_DEPS: DivertBinariesDeps = { gitStatus, storeWorkspaceBlob };

export async function divertWorktreeBinaries(
  customerDir: string,
  target: WorkspaceBlobTarget,
  deps: DivertBinariesDeps = DEFAULT_DEPS,
): Promise<DivertBinariesResult> {
  const status = await deps.gitStatus(customerDir, { untracked: "all" });
  if (!status.ok) {
    return { diverted: [], failures: [`git status failed: ${status.error.code}`], failedPaths: [] };
  }

  const diverted: DivertedBlob[] = [];
  const failures: string[] = [];
  const failedPaths: string[] = [];

  for (const entry of status.entries) {
    if (entry.change === "deleted" || !isDivertablePath(entry.path)) continue;
    const absolute = path.join(customerDir, entry.path);

    try {
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        failures.push(`${entry.path}: symlink, not diverted`);
        failedPaths.push(entry.path);
        continue;
      }
      if (!stats.isFile()) continue;

      if (stats.size > MAX_DIVERTED_BLOB_BYTES) {
        failures.push(`${entry.path}: ${stats.size} bytes exceeds the blob limit`);
        failedPaths.push(entry.path);
        continue;
      }

      if (!(await sniffLooksBinary(absolute))) continue;
      const contents = await readFile(absolute);

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
      failedPaths.push(entry.path);
    }
  }

  return { diverted, failures, failedPaths };
}
