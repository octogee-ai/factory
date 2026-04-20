/**
 * File read endpoints — GET /files (directory listing) + GET /file
 * (single file content, git-backed or blob-backed).
 *
 * File authorization runs through `withFileTarget` (lib/fileTarget.ts),
 * which resolves the target repo + GCS prefix and enforces workspace or
 * project ownership/membership. The route body only runs once that gate
 * has passed.
 */
import { Router } from "express";
import { storage } from "../../lib/db";
import { validateFilePath } from "../../lib/path-validation";
import { withFileTarget } from "../../lib/fileTarget";
import { getManifest } from "../../lib/manifest";
import { customerGiteaApi, getCustomerGiteaToken, HIDDEN } from "./helpers";

const router = Router();

router.get("/files", withFileTarget(async (req, res, _next, target) => {
  const path = (req.query.path as string) ?? "";
  const bustCache = req.query.nocache === "1";

  if (path) {
    const pathError = validateFilePath(path);
    if (pathError) { res.status(400).json({ error: pathError }); return; }
  }

  const { repoName } = target;
  const apiPath = path ? `${repoName}/contents/${path}` : `${repoName}/contents`;

  interface GiteaContentEntry {
    name: string;
    path: string;
    type: string;
    size?: number;
  }
  let contents: GiteaContentEntry[];
  try {
    const raw = await customerGiteaApi(req, apiPath);
    contents = (Array.isArray(raw) ? raw : [raw]) as GiteaContentEntry[];
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

  const manifest = await getManifest(getCustomerGiteaToken(req), repoName, bustCache);
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

  const files = gitFiles.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  res.json({ files });
}));

router.get("/file", withFileTarget(async (req, res, _next, target) => {
  const path = req.query.path as string;
  if (!path) { res.status(400).json({ error: "Missing path" }); return; }

  const pathError = validateFilePath(path);
  if (pathError) { res.status(400).json({ error: pathError }); return; }

  const parts = path.split("/");
  if (parts.some((p) => HIDDEN.has(p) || p.startsWith("."))) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { repoName } = target;
  const manifest = await getManifest(getCustomerGiteaToken(req), repoName);
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

  const file = (await customerGiteaApi(req, `${repoName}/contents/${path}`)) as {
    content?: string;
    sha?: string;
  };
  const content = Buffer.from(file.content ?? "", "base64").toString("utf-8");
  res.json({ content, path, sha: file.sha, source: "git" });
}));

export default router;
