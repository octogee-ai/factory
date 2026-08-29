import { constants, type Stats } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";

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

interface ConfinedFile {
  handle: FileHandle;
  entryPath: string;
  close: () => Promise<void>;
}

function descriptorChildPath(directory: FileHandle, name: string): string {
  const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  return `${descriptorRoot}/${directory.fd}/${name}`;
}

async function closeHandles(handles: FileHandle[]): Promise<void> {
  const results = await Promise.allSettled(handles.reverse().map((handle) => handle.close()));
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

function confinedPathSegments(relativePath: string): string[] {
  const segments = relativePath.split("/");
  if (
    !isDivertablePath(relativePath) ||
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("path is outside the customer workspace");
  }
  return segments;
}

function confinedOpenError(error: unknown): never {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : null;
  if (code === "ELOOP" || code === "ENOTDIR") {
    throw new Error("symlink or non-directory path component, not diverted");
  }
  throw error;
}

async function openConfinedFile(customerDir: string, relativePath: string): Promise<ConfinedFile> {
  if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    throw new Error("confined file opens are unavailable on this platform");
  }
  const segments = confinedPathSegments(relativePath);
  const handles: FileHandle[] = [];
  try {
    let directory = await open(
      customerDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    handles.push(directory);
    for (const segment of segments.slice(0, -1)) {
      directory = await open(
        descriptorChildPath(directory, segment),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(directory);
    }
    const entryPath = descriptorChildPath(directory, segments.at(-1)!);
    const handle = await open(entryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    handles.push(handle);
    return {
      handle,
      entryPath,
      close: () => closeHandles(handles),
    };
  } catch (error) {
    await closeHandles(handles);
    return confinedOpenError(error);
  }
}

function sameFileSnapshot(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

async function divertBinaryEntry(
  customerDir: string,
  relativePath: string,
  target: WorkspaceBlobTarget,
  deps: DivertBinariesDeps,
): Promise<DivertedBlob | null> {
  const confined = await openConfinedFile(customerDir, relativePath);
  try {
    const stats = await confined.handle.stat();
    if (!stats.isFile()) return null;
    if (stats.size > MAX_DIVERTED_BLOB_BYTES) {
      throw new Error(`${stats.size} bytes exceeds the blob limit`);
    }
    const contents = await confined.handle.readFile();
    const afterRead = await confined.handle.stat();
    if (contents.length !== stats.size || !sameFileSnapshot(stats, afterRead)) {
      throw new Error("file changed while reading");
    }
    if (!looksBinary(contents.subarray(0, BINARY_SNIFF_BYTES))) return null;

    await deps.storeWorkspaceBlob(target, relativePath, contents, getMimeType(getExtension(relativePath)));
    const current = await lstat(confined.entryPath);
    if (!current.isFile() || !sameFileSnapshot(afterRead, current)) {
      throw new Error("file changed before removal");
    }
    await unlink(confined.entryPath);
    return { path: relativePath, size: stats.size };
  } finally {
    await confined.close();
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
      const divertedBlob = await divertBinaryEntry(customerDir, entry.path, target, deps);
      if (divertedBlob) diverted.push(divertedBlob);
    } catch (err) {
      failures.push(`${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
      failedPaths.push(entry.path);
    }
  }

  return { diverted, failures, failedPaths };
}
