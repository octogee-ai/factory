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

async function divertBinaryEntry(
  absolute: string,
  relativePath: string,
  target: WorkspaceBlobTarget,
  deps: DivertBinariesDeps,
): Promise<DivertedBlob | null> {
  if ((await lstat(absolute)).isSymbolicLink()) throw new Error("symlink, not diverted");
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    if (stats.size > MAX_DIVERTED_BLOB_BYTES) {
      throw new Error(`${stats.size} bytes exceeds the blob limit`);
    }
    const sample = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, stats.size));
    const { bytesRead: sampleBytes } = await handle.read(sample, 0, sample.length, 0);
    if (!looksBinary(sample.subarray(0, sampleBytes))) return null;

    const contents = Buffer.alloc(stats.size);
    const { bytesRead } = await handle.read(contents, 0, contents.length, 0);
    if (bytesRead !== stats.size) throw new Error("file changed while reading");
    await deps.storeWorkspaceBlob(target, relativePath, contents, getMimeType(getExtension(relativePath)));
    const current = await lstat(absolute);
    if (!current.isFile() || current.dev !== stats.dev || current.ino !== stats.ino) {
      throw new Error("file changed before removal");
    }
    await unlink(absolute);
    return { path: relativePath, size: stats.size };
  } finally {
    await handle.close();
  }
}

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
    try {
      const divertedBlob = await divertBinaryEntry(path.join(customerDir, entry.path), entry.path, target, deps);
      if (divertedBlob) diverted.push(divertedBlob);
    } catch (err) {
      failures.push(`${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
      failedPaths.push(entry.path);
    }
  }

  return { diverted, failures, failedPaths };
}
