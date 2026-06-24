import { Router } from "express";
import { storage } from "../../lib/db.js";
import { validateFilePath } from "../../lib/path-validation.js";
import { withFileTarget } from "../../lib/fileTarget.js";
import { getManifest } from "../../lib/manifest.js";
import type { Manifest } from "../../lib/manifest.js";
import { isOversizeFile } from "../../lib/github.js";
import { giteaSudoUser, HIDDEN, isTargetPathWritable, pathHasReservedOrHiddenSegment, repoContentsApi } from "./helpers.js";

const router = Router();

export interface RepoContentEntry {
  name: string;
  path: string;
  type: string;
  size?: number;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  source: "git" | "blob";
  thumbnailUrl?: string;
}

export interface WorkspaceFilesResponse {
  files: WorkspaceFileEntry[];
  readOnly?: boolean;
}

type ListPathValidation = { ok: true } | { ok: false; status: 400 | 403; error: string };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function validateListPath(path: string): ListPathValidation {
  if (!path) return { ok: true };

  const pathError = validateFilePath(path);
  if (pathError) return { ok: false, status: 400, error: pathError };

  if (pathHasReservedOrHiddenSegment(path)) {
    return { ok: false, status: 403, error: "Access denied" };
  }

  return { ok: true };
}

async function repoContentEntries(
  target: Parameters<typeof repoContentsApi>[0],
  path: string,
): Promise<RepoContentEntry[] | null> {
  try {
    const raw = await repoContentsApi(target, path);
    return (Array.isArray(raw) ? raw : [raw]) as RepoContentEntry[];
  } catch (e) {
    if (errorMessage(e).includes("404")) return null;
    throw e;
  }
}

export function repoFileEntries(contents: RepoContentEntry[]): WorkspaceFileEntry[] {
  return contents
    .filter((file) => !HIDDEN.has(file.name) && !file.name.startsWith("."))
    .map((file) => ({
      name: file.name,
      path: file.path,
      type: file.type === "dir" ? "dir" : "file",
      size: file.size ?? 0,
      source: "git",
    }));
}

export function blobFileEntries(
  manifest: Manifest,
  path: string,
  gitPaths: Set<string>,
): WorkspaceFileEntry[] {
  const prefix = path ? `${path}/` : "";
  const entries: WorkspaceFileEntry[] = [];

  for (const [manifestPath, entry] of Object.entries(manifest)) {
    if (!manifestPath.startsWith(prefix) || gitPaths.has(manifestPath)) continue;

    const relative = manifestPath.slice(prefix.length);
    if (relative.includes("/")) continue;

    entries.push({
      name: relative,
      path: manifestPath,
      type: "file",
      size: entry.size ?? 0,
      source: "blob",
      ...(entry.thumbnailUrl ? { thumbnailUrl: entry.thumbnailUrl } : {}),
    });
  }

  return entries;
}

export function sortWorkspaceFiles(files: WorkspaceFileEntry[]): WorkspaceFileEntry[] {
  return [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function workspaceFileEntries(
  target: Parameters<typeof repoContentsApi>[0],
  path: string,
  bustCache: boolean,
): Promise<WorkspaceFileEntry[] | null> {
  const contents = await repoContentEntries(target, path);
  if (!contents) return null;

  const gitFiles = repoFileEntries(contents);
  if (target.provider === "github") return sortWorkspaceFiles(gitFiles);

  const manifest = await getManifest(giteaSudoUser(target), target.org, target.repoName, bustCache);
  const gitPaths = new Set(gitFiles.map((file) => file.path));
  return sortWorkspaceFiles([
    ...gitFiles,
    ...blobFileEntries(manifest, path, gitPaths),
  ]);
}

export async function workspaceFilesResponse(
  target: Parameters<typeof repoContentsApi>[0],
  path: string,
  bustCache: boolean,
): Promise<WorkspaceFilesResponse> {
  const files = await workspaceFileEntries(target, path, bustCache);
  if (!files) return { files: [] };

  return { files, readOnly: target.provider !== "gitea" };
}

router.get("/files", withFileTarget(async (req, res, _next, target) => {
  const path = (req.query.path as string) ?? "";
  const bustCache = req.query.nocache === "1";
  const pathValidation = validateListPath(path);
  if (!pathValidation.ok) {
    res.status(pathValidation.status).json({ error: pathValidation.error });
    return;
  }

  res.json(await workspaceFilesResponse(target, path, bustCache));
}, { allowWorkspaceMembers: true }));

router.get("/file", withFileTarget(async (req, res, _next, target) => {
  const path = req.query.path as string;
  if (!path) { res.status(400).json({ error: "Missing path" }); return; }

  const pathError = validateFilePath(path);
  if (pathError) { res.status(400).json({ error: pathError }); return; }

  if (pathHasReservedOrHiddenSegment(path)) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  if (target.provider !== "github") {
    const manifest = await getManifest(giteaSudoUser(target), target.org, target.repoName);
    const blobEntry = manifest[path];

    if (blobEntry) {
      const bucket = storage.bucket();
      const file = bucket.file(blobEntry.gcsPath);
      const [signedUrl] = await file.getSignedUrl({
        action: "read",
        expires: Date.now() + 60 * 60 * 1000,
      });
      res.json({
        content: null,
        downloadUrl: signedUrl,
        mimeType: blobEntry.mimeType,
        size: blobEntry.size,
        path,
        source: "blob",
      });
      return;
    }
  }

  const file = (await repoContentsApi(target, path)) as {
    content?: string;
    sha?: string;
    encoding?: string;
    size?: number;
  };
  if (isOversizeFile(file)) {
    res.status(413).json({
      error: "File too large to display inline",
      code: "FILE_TOO_LARGE",
      size: file.size ?? null,
      path,
    });
    return;
  }
  const content = Buffer.from(file.content ?? "", "base64").toString("utf-8");
  res.json({
    content,
    path,
    sha: file.sha,
    source: "git",
    writable: isTargetPathWritable(target, path),
  });
}, { allowWorkspaceMembers: true }));

export default router;
