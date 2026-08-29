import { db, storage } from "./db.js";
import { logger } from "../middleware/logging.js";
import {
  getManifestForQuota,
  updateManifest,
  removeFromManifest,
} from "./manifest.js";
import type { FileTarget } from "./fileTarget.js";
import {
  getExtension,
  getMimeType,
  IMAGE_EXTENSIONS,
} from "../routes/workspace/helpers.js";
import { invalidateWorkspaceFileResponseCache } from "../routes/workspace/file-response-cache.js";
import { freeWorkspaceStorageLimitBytes } from "./free-storage.js";
import {
  DEFAULT_PLATFORM_FREE_CONFIG,
  parsePlatformFreeConfig,
} from "@octogee/shared/types/platform-config";
import {
  finalizeWorkspaceStorageReservation,
  releaseWorkspaceStorage,
  reserveWorkspaceStorage,
  rollbackWorkspaceStorageReservation,
  type WorkspaceStorageReservation,
} from "./workspace-storage-quota.js";

export { WorkspaceStorageQuotaError } from "./workspace-storage-quota.js";

export interface StoredWorkspaceBlob {
  gcsPath: string;
  size: number;
  thumbnailUrl?: string;
  thumbnailError?: string;
}

export interface WorkspaceBlobOptions {
  maxStorageBytes?: number;
}

/** Matches the blob download URL's lifetime. Signed per request, never stored. */
export const BLOB_SIGNED_URL_TTL_MS = 60 * 60 * 1000;

interface ThumbnailResult {
  hasThumbnail?: boolean;
  thumbnailUrl?: string;
  thumbnailError?: string;
}

async function configuredWorkspaceStorageLimitBytes(
  target: FileTarget,
): Promise<number | undefined> {
  if (target.projectSlug !== null) return undefined;
  const workspace = await db.doc(`workspaces/${target.slug}`).get();
  const ownerUid = workspace.data()?.ownerUid;
  if (typeof ownerUid !== "string" || !ownerUid) {
    throw new Error(`workspace ${target.slug} has no storage owner`);
  }
  const [owner, configSnapshot] = await Promise.all([
    db.doc(`users/${ownerUid}`).get(),
    db.doc("platformConfig/free").get(),
  ]);
  if (!owner.exists) throw new Error(`workspace storage owner ${ownerUid} was not found`);
  const config = parsePlatformFreeConfig(configSnapshot.data());
  if (!config) {
    logger.warn("platformConfig/free missing or invalid; using compiled Free storage allowance");
  }
  return freeWorkspaceStorageLimitBytes(
    owner.data() ?? {},
    false,
    config ?? DEFAULT_PLATFORM_FREE_CONFIG,
  );
}

async function reserveBlobStorage(
  target: FileTarget,
  filePath: string,
  fileSize: number,
  limitBytes: number | undefined,
): Promise<WorkspaceStorageReservation | null> {
  if (limitBytes === undefined) return null;
  const manifest = await getManifestForQuota(target.gcsPrefix);
  const currentBytes = Object.values(manifest)
    .reduce((sum, entry) => sum + entry.size, 0);
  return reserveWorkspaceStorage(db, {
    slug: target.slug,
    path: filePath,
    newSize: fileSize,
    manifestBytes: currentBytes,
    manifestPathBytes: manifest[filePath]?.size ?? 0,
    limitBytes,
  });
}

async function createBlobThumbnail(
  target: FileTarget,
  filePath: string,
  fileBuffer: Buffer,
  extension: string,
  bucket: ReturnType<typeof storage.bucket>,
): Promise<ThumbnailResult> {
  if (!IMAGE_EXTENSIONS.has(extension)) return {};
  try {
    const sharp = (await import("sharp")).default;
    const thumbBuffer = await sharp(fileBuffer)
      .resize(128, 128, { fit: "inside" })
      .png()
      .toBuffer();
    const thumbFile = bucket.file(`${target.gcsPrefix}/.thumbs/${filePath}.png`);
    await thumbFile.save(thumbBuffer, { metadata: { contentType: "image/png" } });
    const [thumbnailUrl] = await thumbFile.getSignedUrl({
      action: "read",
      expires: Date.now() + BLOB_SIGNED_URL_TTL_MS,
    });
    return { hasThumbnail: true, thumbnailUrl };
  } catch (error) {
    const thumbnailError = error instanceof Error ? error.message : String(error);
    logger.warn(`Thumbnail generation failed for ${filePath}: ${thumbnailError}`);
    return { thumbnailError };
  }
}

async function rollbackReservation(
  reservation: WorkspaceStorageReservation | null,
  error: unknown,
): Promise<never> {
  if (!reservation) throw error;
  try {
    await rollbackWorkspaceStorageReservation(db, reservation);
  } catch (rollbackError) {
    throw new AggregateError(
      [error, rollbackError],
      "workspace blob write failed and its storage reservation could not be rolled back",
    );
  }
  throw error;
}

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
  options: WorkspaceBlobOptions = {},
): Promise<StoredWorkspaceBlob> {
  const maxStorageBytes = options.maxStorageBytes ??
    await configuredWorkspaceStorageLimitBytes(target);
  const reservation = await reserveBlobStorage(
    target,
    filePath,
    fileBuffer.length,
    maxStorageBytes,
  );
  try {
    const bucket = storage.bucket();
    const gcsPath = `${target.gcsPrefix}/${filePath}`;
    const ext = getExtension(filePath);
    const contentType = mimeType || getMimeType(ext);

    await bucket.file(gcsPath).save(fileBuffer, { metadata: { contentType } });

    const { hasThumbnail, thumbnailUrl, thumbnailError } = await createBlobThumbnail(
      target,
      filePath,
      fileBuffer,
      ext,
      bucket,
    );

    await updateManifest(target.gcsPrefix, {
      [filePath]: {
        type: "blob",
        gcsPath,
        size: fileBuffer.length,
        mimeType: contentType,
        uploadedAt: new Date().toISOString(),
        ...(hasThumbnail ? { hasThumbnail: true } : {}),
      },
    });
    if (reservation) await finalizeWorkspaceStorageReservation(db, reservation);
    invalidateWorkspaceFileResponseCache(target);

    return {
      gcsPath,
      size: fileBuffer.length,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(thumbnailError ? { thumbnailError } : {}),
    };
  } catch (error) {
    return rollbackReservation(reservation, error);
  }
}

/** Remove a workspace blob, its thumbnail, and its manifest entry — no orphans. */
export async function removeWorkspaceBlob(target: FileTarget, filePath: string): Promise<void> {
  const manifest = target.projectSlug === null
    ? await getManifestForQuota(target.gcsPrefix)
    : {};
  const removedBytes = manifest[filePath]?.size ?? 0;
  const bucket = storage.bucket();
  const ext = getExtension(filePath);
  await bucket.file(`${target.gcsPrefix}/${filePath}`).delete({ ignoreNotFound: true });
  if (IMAGE_EXTENSIONS.has(ext)) {
    await bucket.file(`${target.gcsPrefix}/.thumbs/${filePath}.png`).delete({ ignoreNotFound: true });
  }
  await removeFromManifest(target.gcsPrefix, filePath);
  if (target.projectSlug === null && removedBytes > 0) {
    await releaseWorkspaceStorage(db, {
      slug: target.slug,
      path: filePath,
      removedBytes,
    });
  }
  invalidateWorkspaceFileResponseCache(target);
}
