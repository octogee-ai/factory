import { Router } from "express";
import { storage } from "../../lib/db.js";
import { validateFilePath } from "../../lib/path-validation.js";
import { withFileTarget } from "../../lib/fileTarget.js";
import { getManifest } from "../../lib/manifest.js";
import { isOversizeFile } from "../../lib/github.js";
import { getCustomerGiteaToken, HIDDEN, isTargetPathWritable, pathHasReservedOrHiddenSegment, repoContentsApi, requireGiteaToken } from "./helpers.js";

const router = Router();

router.get("/files", withFileTarget(async (req, res, _next, target) => {
  if (target.provider === "gitea" && !target.giteaToken && !requireGiteaToken(req, res)) return;
  const path = (req.query.path as string) ?? "";
  const bustCache = req.query.nocache === "1";

  if (path) {
    const pathError = validateFilePath(path);
    if (pathError) { res.status(400).json({ error: pathError }); return; }
    if (pathHasReservedOrHiddenSegment(path)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  interface RepoContentEntry {
    name: string;
    path: string;
    type: string;
    size?: number;
  }
  let contents: RepoContentEntry[];
  try {
    const raw = await repoContentsApi(req, target, path);
    contents = (Array.isArray(raw) ? raw : [raw]) as RepoContentEntry[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("404")) { res.json({ files: [] }); return; }
    throw e;
  }

  interface FileEntry {
    name: string;
    path: string;
    type: "dir" | "file";
    size: number;
    source: "git" | "blob";
    thumbnailUrl?: string;
  }
  const gitFiles: FileEntry[] = contents
    .filter((f) => !HIDDEN.has(f.name) && !f.name.startsWith("."))
    .map((f) => ({
      name: f.name,
      path: f.path,
      type: f.type === "dir" ? ("dir" as const) : ("file" as const),
      size: f.size ?? 0,
      source: "git" as const,
    }));

  if (target.provider !== "github") {
    const manifest = await getManifest(getCustomerGiteaToken(req, target), target.org, target.repoName, bustCache);
    const gitPaths = new Set(gitFiles.map((f) => f.path));
    const prefix = path ? path + "/" : "";

    for (const [manifestPath, entry] of Object.entries(manifest)) {
      if (!manifestPath.startsWith(prefix)) continue;
      const relative = manifestPath.slice(prefix.length);
      if (relative.includes("/")) continue;
      if (gitPaths.has(manifestPath)) continue;

      gitFiles.push({
        name: relative,
        path: manifestPath,
        type: "file",
        size: entry.size ?? 0,
        source: "blob" as const,
        ...(entry.thumbnailUrl ? { thumbnailUrl: entry.thumbnailUrl } : {}),
      });
    }
  }

  const files = gitFiles.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  res.json({ files, readOnly: target.provider !== "gitea" });
}, { allowWorkspaceMembers: true }));

router.get("/file", withFileTarget(async (req, res, _next, target) => {
  if (target.provider === "gitea" && !target.giteaToken && !requireGiteaToken(req, res)) return;
  const path = req.query.path as string;
  if (!path) { res.status(400).json({ error: "Missing path" }); return; }

  const pathError = validateFilePath(path);
  if (pathError) { res.status(400).json({ error: pathError }); return; }

  if (pathHasReservedOrHiddenSegment(path)) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  if (target.provider !== "github") {
    const manifest = await getManifest(getCustomerGiteaToken(req, target), target.org, target.repoName);
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

  const file = (await repoContentsApi(req, target, path)) as {
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
