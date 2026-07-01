import { storage } from "./db.js";
import { logger } from "../middleware/logging.js";
import { updateManifest, removeFromManifest } from "./manifest.js";
import type { FileTarget } from "./fileTarget.js";
import {
  getExtension,
  getMimeType,
  IMAGE_EXTENSIONS,
  giteaSudoUser,
} from "../routes/workspace/helpers.js";
import { invalidateWorkspaceFileResponseCache } from "../routes/workspace/file-response-cache.js";

export interface StoredWorkspaceBlob {
  gcsPath: string;
  size: number;
  thumbnailUrl?: string;
  thumbnailError?: string;
}

const THUMB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The single way a binary lands in a workspace: save to GCS, generate a 128²
 * thumbnail for images, and write the `.files/manifest.json` placeholder in
 * Gitea. GCS durability + boot-time recovery come for free via blob-sync, and
 * the Files view reads the manifest. Used by `/upload-blob` and by the coach
 * avatar path — one path, no duplication.
 */
export async function storeWorkspaceBlob(
  target: FileTarget,
  filePath: string,
  fileBuffer: Buffer,
  mimeType?: string,
): Promise<StoredWorkspaceBlob> {
  const bucket = storage.bucket();
  const gcsPath = `${target.gcsPrefix}/${filePath}`;
  const ext = getExtension(filePath);
  const contentType = mimeType || getMimeType(ext);

  await bucket.file(gcsPath).save(fileBuffer, { metadata: { contentType } });

  let thumbnailUrl: string | undefined;
  let thumbnailError: string | undefined;
  if (IMAGE_EXTENSIONS.has(ext)) {
    try {
      const sharp = (await import("sharp")).default;
      const thumbBuffer = await sharp(fileBuffer).resize(128, 128, { fit: "inside" }).png().toBuffer();
      const thumbFile = bucket.file(`${target.gcsPrefix}/.thumbs/${filePath}.png`);
      await thumbFile.save(thumbBuffer, { metadata: { contentType: "image/png" } });
      const [signedUrl] = await thumbFile.getSignedUrl({
        action: "read",
        expires: Date.now() + THUMB_TTL_MS,
      });
      thumbnailUrl = signedUrl;
    } catch (e) {
      thumbnailError = e instanceof Error ? e.message : String(e);
      logger.warn(`Thumbnail generation failed for ${filePath}: ${thumbnailError}`);
    }
  }

  await updateManifest(giteaSudoUser(target), target.org, target.repoName, {
    [filePath]: {
      type: "blob",
      gcsPath,
      size: fileBuffer.length,
      mimeType: contentType,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      uploadedAt: new Date().toISOString(),
    },
  });
  invalidateWorkspaceFileResponseCache(target);

  return {
    gcsPath,
    size: fileBuffer.length,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(thumbnailError ? { thumbnailError } : {}),
  };
}

/** Remove a workspace blob, its thumbnail, and its manifest entry — no orphans. */
export async function removeWorkspaceBlob(target: FileTarget, filePath: string): Promise<void> {
  const bucket = storage.bucket();
  const ext = getExtension(filePath);
  await bucket.file(`${target.gcsPrefix}/${filePath}`).delete({ ignoreNotFound: true });
  if (IMAGE_EXTENSIONS.has(ext)) {
    await bucket.file(`${target.gcsPrefix}/.thumbs/${filePath}.png`).delete({ ignoreNotFound: true });
  }
  await removeFromManifest(giteaSudoUser(target), target.org, target.repoName, filePath);
  invalidateWorkspaceFileResponseCache(target);
}
