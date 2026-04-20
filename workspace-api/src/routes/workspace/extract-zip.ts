/**
 * POST /extract-zip — extract a ZIP from Storage into the workspace repo.
 *
 * ZIP-bomb guard: 200 MB archive cap, 50 MB per-entry cap, 10 k entry cap.
 * Text files land in Gitea (base64); binaries go to GCS + manifest. The
 * original zip is deleted from GCS and de-listed from the manifest on
 * success.
 */
import { Router, Request, Response, NextFunction } from "express";
import JSZip from "jszip";
import { storage } from "../../lib/db";
import { logger } from "../../middleware/logging";
import { updateManifest, removeFromManifest } from "../../lib/manifest";
import {
  customerGiteaApi,
  ensureSlug,
  getCustomerGiteaToken,
  getExtension,
  getMimeType,
  isTextFile,
} from "./helpers";

const router = Router();

router.post("/extract-zip", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const slug = ensureSlug(req, res);
    if (!slug) return;

    const { zipPath } = req.body as { zipPath: string };
    if (!zipPath) { res.status(400).json({ error: "Missing zipPath" }); return; }

    const bucket = storage.bucket();
    const gcsZipPath = `customers/${slug}/${zipPath}`;
    const repoName = `${slug}-workspace`;

    const zipFile = bucket.file(gcsZipPath);
    const [zipBuffer] = await zipFile.download();
    // ZIP-bomb guard: the upload path caps archive size in GCS, but re-cap
    // here so a misconfigured bucket rule can't feed us a 10GB tarball.
    const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024; // 200 MB
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

    // Per-entry cap + entry-count cap complete the ZIP-bomb guard started at
    // the archive-size check above. 50MB / 10k entries is generous enough
    // for legitimate design-asset uploads while killing "42.zip"-style fan-out.
    const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
    const MAX_ENTRIES = 10000;
    if (fileEntries.length > MAX_ENTRIES) {
      res.status(413).json({ error: `Archive has ${fileEntries.length} entries (max ${MAX_ENTRIES})` });
      return;
    }

    for (const [relativePath, zipEntry] of fileEntries) {
      if (relativePath.startsWith("__MACOSX/") || relativePath.includes("/.DS_Store")) continue;

      const targetPath = `${baseDir}/${relativePath}`;
      const fileBuffer = await zipEntry.async("nodebuffer");
      if (fileBuffer.length > MAX_ENTRY_BYTES) {
        res.status(413).json({ error: `Entry "${relativePath}" exceeds ${MAX_ENTRY_BYTES} bytes` });
        return;
      }
      const ext = getExtension(relativePath);

      if (isTextFile(relativePath)) {
        const content = fileBuffer.toString("base64");
        let sha: string | undefined;
        try {
          const existing = (await customerGiteaApi(req, `${repoName}/contents/${targetPath}`)) as { sha?: string };
          sha = existing.sha;
        } catch { /* new file */ }

        await customerGiteaApi(req, `${repoName}/contents/${targetPath}`, "PUT", {
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
      await updateManifest(getCustomerGiteaToken(req), repoName, manifestEntries);
    }

    try { await zipFile.delete(); } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`Failed to delete ZIP after extraction: ${msg}`);
    }

    // Remove the original zip from the manifest if it was tracked there
    // (e.g. the user uploaded it via /upload-blob before extracting).
    await removeFromManifest(
      getCustomerGiteaToken(req),
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
