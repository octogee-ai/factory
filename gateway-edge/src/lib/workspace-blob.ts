import { db, storage } from "./db.js";
import { uploadProjectBlobViaBroker } from "./project-blob-upload.js";
import { createHash } from "node:crypto";
import { readPlatformFreeConfig } from "./platform-free-config.js";
import { logger } from "../middleware/logging.js";
import {
  getManifestForQuota,
  updateManifest,
  removeFromManifest,
} from "./manifest.js";
import type { FileTarget } from "./fileTarget.js";

export interface WorkspaceBlobTarget {
  slug: string;
  projectSlug: string | null;
  gcsPrefix: string;
  provider?: FileTarget["provider"];
  org?: string;
  repoName?: string;
}

function invalidateListingCacheIfAddressable(target: WorkspaceBlobTarget): void {
  if (!target.provider || target.org === undefined || target.repoName === undefined) return;
  invalidateWorkspaceFileResponseCache(target as FileTarget);
}
import {
  getExtension,
  getMimeType,
  IMAGE_EXTENSIONS,
} from "../routes/workspace/helpers.js";
import { invalidateWorkspaceFileResponseCache } from "../routes/workspace/file-response-cache.js";
import { freeWorkspaceStorageLimitBytes } from "./free-storage.js";
import {
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
  sha256?: string;
}

export interface WorkspaceBlobOptions {
  maxStorageBytes?: number;
  immutable?: boolean;
}

export const BLOB_SIGNED_URL_TTL_MS = 60 * 60 * 1000;

interface ThumbnailResult {
  hasThumbnail?: boolean;
  thumbnailUrl?: string;
  thumbnailError?: string;
}

async function configuredWorkspaceStorageLimitBytes(
  target: WorkspaceBlobTarget,
): Promise<number | undefined> {
  if (target.projectSlug !== null) return undefined;
  const workspace = await db.doc(`workspaces/${target.slug}`).get();
  const ownerUid = workspace.data()?.ownerUid;
  if (typeof ownerUid !== "string" || !ownerUid) {
    throw new Error(`workspace ${target.slug} has no storage owner`);
  }
  const [owner, config] = await Promise.all([
    db.doc(`users/${ownerUid}`).get(),
    readPlatformFreeConfig(),
  ]);
  if (!owner.exists) throw new Error(`workspace storage owner ${ownerUid} was not found`);
  return freeWorkspaceStorageLimitBytes(owner.data() ?? {}, false, config);
}

async function reserveBlobStorage(
  target: WorkspaceBlobTarget,
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
  target: WorkspaceBlobTarget,
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

async function saveBlobObject(file: ReturnType<ReturnType<typeof storage.bucket>["file"]>, fileBuffer: Buffer, contentType: string, sha256?: string): Promise<void> {
    try {
      await file.save(fileBuffer, { metadata: { contentType }, ...(sha256 ? { preconditionOpts: { ifGenerationMatch: 0 } } : {}) });
    } catch (error) {
      if (!sha256 || String((error as { code?: unknown }).code) !== "412") throw error;
    }
    if (sha256) {
      const [metadata] = await file.getMetadata();
      // eslint-disable-next-line sonarjs/hashing -- GCS MD5 is a transport checksum; immutable identity uses SHA-256
      if (Number(metadata.size) !== fileBuffer.length || metadata.md5Hash !== createHash("md5").update(fileBuffer).digest("base64")) {
        throw new Error("immutable asset size or checksum mismatch");
      }
    }
}

/**
 * The single way a binary lands in a workspace: save to GCS, generate a 128²
 * thumbnail for images, and write the `.files/manifest.json` placeholder in
 * Gitea. GCS durability + boot-time recovery come for free via blob-sync, and
 * the Files view reads the manifest. Used by `/upload-blob` and by the coach
 * avatar path — one path, no duplication.
 */
export async function storeWorkspaceBlob(
  target: WorkspaceBlobTarget,
  filePath: string,
  fileBuffer: Buffer,
  mimeType?: string,
  options: WorkspaceBlobOptions = {},
): Promise<StoredWorkspaceBlob> {
  const ext = getExtension(filePath);
  const contentType = mimeType || getMimeType(ext);
  if (options.immutable && process.env.FLEET_BROKER_URL) {
    return uploadProjectBlobViaBroker(process.env.FLEET_BROKER_URL, target, fileBuffer, contentType);
  }
  const sha256 = options.immutable ? createHash("sha256").update(fileBuffer).digest("hex") : undefined;
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
    const gcsPath = sha256 ? `${target.gcsPrefix}/.objects/${sha256}` : `${target.gcsPrefix}/${filePath}`;
    const file = bucket.file(gcsPath);
    await saveBlobObject(file, fileBuffer, contentType, sha256);

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
        ...(sha256 ? { sha256 } : {}),
        ...(hasThumbnail ? { hasThumbnail: true } : {}),
      },
    });
    if (reservation) await finalizeWorkspaceStorageReservation(db, reservation);
    invalidateListingCacheIfAddressable(target);

    return {
      gcsPath,
      size: fileBuffer.length,
      ...(sha256 ? { sha256 } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(thumbnailError ? { thumbnailError } : {}),
    };
  } catch (error) {
    return rollbackReservation(reservation, error);
  }
}

/** Remove a workspace blob, its thumbnail, and its manifest entry — no orphans. */
export async function removeWorkspaceBlob(target: WorkspaceBlobTarget, filePath: string): Promise<void> {
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
  invalidateListingCacheIfAddressable(target);
}
