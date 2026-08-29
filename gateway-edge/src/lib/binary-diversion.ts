import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

import {
  isDivertableWorkspacePath,
  looksLikeWorkspaceBinary,
  MAX_WORKSPACE_BINARY_BYTES,
  WORKSPACE_BINARY_SNIFF_BYTES,
} from "@octogee/core/workspace-binary";
import { gitStatus } from "./workspace-git.js";
import { storeWorkspaceBlob, type WorkspaceBlobTarget } from "./workspace-blob.js";
import { getMimeType, getExtension } from "../routes/workspace/helpers.js";

export const BINARY_SNIFF_BYTES = WORKSPACE_BINARY_SNIFF_BYTES;

export const MAX_DIVERTED_BLOB_BYTES = MAX_WORKSPACE_BINARY_BYTES;

export function looksBinary(sample: Buffer): boolean {
  return looksLikeWorkspaceBinary(sample);
}

export function isDivertablePath(relativePath: string): boolean {
  return isDivertableWorkspacePath(relativePath);
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
      if ((await lstat(absolute)).isSymbolicLink()) {
        failures.push(`${entry.path}: symlink, not diverted`);
        failedPaths.push(entry.path);
        continue;
      }
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) continue;
        if (stats.size > MAX_DIVERTED_BLOB_BYTES) {
          failures.push(`${entry.path}: ${stats.size} bytes exceeds the blob limit`);
          failedPaths.push(entry.path);
          continue;
        }
        const sample = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, stats.size));
        const { bytesRead: sampleBytes } = await handle.read(sample, 0, sample.length, 0);
        if (!looksBinary(sample.subarray(0, sampleBytes))) continue;

        const contents = Buffer.alloc(stats.size);
        const { bytesRead } = await handle.read(contents, 0, contents.length, 0);
        if (bytesRead !== stats.size) throw new Error("file changed while reading");
        await deps.storeWorkspaceBlob(
          target,
          entry.path,
          contents,
          getMimeType(getExtension(entry.path)),
        );
        const current = await lstat(absolute);
        if (!current.isFile() || current.dev !== stats.dev || current.ino !== stats.ino) {
          throw new Error("file changed before removal");
        }
        await unlink(absolute);
        diverted.push({ path: entry.path, size: stats.size });
      } finally {
        await handle.close();
      }
    } catch (err) {
      failures.push(`${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
      failedPaths.push(entry.path);
    }
  }

  return { diverted, failures, failedPaths };
}
