import { Router, Request, Response, NextFunction } from "express";
import JSZip from "jszip";
import { storage } from "../../lib/db.js";
import { logger } from "../../middleware/logging.js";
import { updateManifest, removeFromManifest } from "../../lib/manifest.js";
import { giteaApiAsUser } from "../../lib/gitea.js";
import { workspaceGiteaOrg, workspaceRepoName } from "../../lib/gitea-naming.js";
import {
  ensureSlug,
  getExtension,
  getMimeType,
  isTextFile,
  validateWorkspacePath,
} from "./helpers.js";

const router = Router();

router.post("/extract-zip", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = ensureSlug(req, res);
    if (!slug) return;

    const { zipPath } = req.body as { zipPath: string };
    if (!zipPath) { res.status(400).json({ error: "Missing zipPath" }); return; }

    const zipPathError = validateWorkspacePath(zipPath);
    if (zipPathError) { res.status(400).json({ error: `Invalid zipPath: ${zipPathError}` }); return; }

    const bucket = storage.bucket();
    const gcsZipPath = `customers/${slug}/${zipPath}`;
    const org = workspaceGiteaOrg(slug);
    const sudoUser = `ws-${slug}`;
    const repoName = workspaceRepoName();

    const zipFile = bucket.file(gcsZipPath);
    const [zipBuffer] = await zipFile.download();
    const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
    if (zipBuffer.length > MAX_ARCHIVE_BYTES) {
      res.status(413).json({ error: "Archive exceeds 200MB limit" });
      return;
    }
    // eslint-disable-next-line sonarjs/no-unsafe-unzip -- size capped above; per-entry cap enforced in the loop below
    const zip = await JSZip.loadAsync(zipBuffer);

    const gitPaths: string[] = [];
    const blobPaths: string[] = [];
    const manifestEntries: Record<string, unknown> = {};

    const zipName = zipPath.split("/").pop()?.replace(/\.zip$/i, "") ?? "extracted";
    const baseDir = zipPath.includes("/")
      ? zipPath.slice(0, zipPath.lastIndexOf("/") + 1) + zipName
      : zipName;

    const fileEntries = Object.entries(zip.files).filter(([, f]) => !f.dir);

    const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
    const MAX_ENTRIES = 10000;
    if (fileEntries.length > MAX_ENTRIES) {
      res.status(413).json({ error: `Archive has ${fileEntries.length} entries (max ${MAX_ENTRIES})` });
      return;
    }

    const safeEntries: Array<[string, typeof fileEntries[number][1]]> = [];
    for (const [relativePath, zipEntry] of fileEntries) {
      if (relativePath.startsWith("__MACOSX/") || relativePath.includes("/.DS_Store")) continue;
      const targetPath = `${baseDir}/${relativePath}`;
      const targetPathError = validateWorkspacePath(targetPath);
      if (targetPathError) {
        res.status(400).json({ error: `Blocked entry "${relativePath}": ${targetPathError}` });
        return;
      }
      safeEntries.push([relativePath, zipEntry]);
    }

    let totalDecompressedBytes = 0;
    const MAX_DECOMPRESSED_BYTES = 500 * 1024 * 1024;

    for (const [relativePath, zipEntry] of safeEntries) {
      const targetPath = `${baseDir}/${relativePath}`;
      const fileBuffer = await zipEntry.async("nodebuffer");
      if (fileBuffer.length > MAX_ENTRY_BYTES) {
        res.status(413).json({ error: `Entry "${relativePath}" exceeds ${MAX_ENTRY_BYTES} bytes` });
        return;
      }
      totalDecompressedBytes += fileBuffer.length;
      if (totalDecompressedBytes > MAX_DECOMPRESSED_BYTES) {
        res.status(413).json({ error: `Total decompressed size exceeds ${MAX_DECOMPRESSED_BYTES} bytes` });
        return;
      }
      const ext = getExtension(relativePath);

      if (isTextFile(relativePath)) {
        const content = fileBuffer.toString("base64");
        let sha: string | undefined;
        try {
          const existing = (await giteaApiAsUser(sudoUser, org, `${repoName}/contents/${targetPath}`)) as { sha?: string };
          sha = existing.sha;
        } catch { /* ignore */ }

        await giteaApiAsUser(sudoUser, org, `${repoName}/contents/${targetPath}`, "PUT", {
          message: `zip-extract: ${relativePath}`,
          content,
          ...(sha ? { sha } : {}),
        });
        gitPaths.push(targetPath);
      } else {
        const gcsPath = `customers/${slug}/${targetPath}`;
        const storageFile = bucket.file(gcsPath);
        await storageFile.save(fileBuffer, { metadata: { contentType: getMimeType(ext) } });
        manifestEntries[targetPath] = {
          type: "blob",
          gcsPath,
          size: fileBuffer.length,
          mimeType: getMimeType(ext),
          uploadedAt: new Date().toISOString(),
        };
        blobPaths.push(targetPath);
      }
    }

    if (Object.keys(manifestEntries).length > 0) {
      await updateManifest(sudoUser, org, repoName, manifestEntries);
    }

    try { await zipFile.delete(); } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`Failed to delete ZIP after extraction: ${msg}`);
    }

    await removeFromManifest(
      sudoUser,
      org,
      repoName,
      zipPath,
      `blob: remove extracted zip ${zipPath} from manifest`,
    );

    res.json({ success: true, extracted: { git: gitPaths, blob: blobPaths } });
  } catch (e) {
    next(e);
  }
});

export default router;
