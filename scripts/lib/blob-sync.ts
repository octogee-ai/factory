/**
 * Octogee Provisioner — Blob Sync (GCS ↔ Local)
 */

import * as fs from "fs";
import * as path from "path";
import { getStorage } from "firebase-admin/storage";
import { log, CUSTOMERS_DIR, BLOB_SYNC_MAX_CONCURRENT, BLOB_SYNC_MAX_SIZE } from "./config.js";
import { MIME_TYPES } from "./helpers.js";

// ── Types ───────────────────────────────────────────────────────────────────────

export interface ManifestEntry {
  type: "blob";
  gcsPath: string;
  size: number;
  mimeType: string;
  thumbnailUrl?: string;
  uploadedAt: string;
}

export type Manifest = Record<string, ManifestEntry>;

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** Recursively list all files in a directory, returning relative paths. Skips hidden files. */
export function listFilesRecursive(dir: string, base: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full, base));
    } else {
      results.push(path.relative(base, full));
    }
  }
  return results;
}

// ── Blob Sync ───────────────────────────────────────────────────────────────────

/** Sync blobs for all customer workspaces. Fire-and-forget with error logging. */
export async function blobSyncAll(): Promise<void> {
  if (!fs.existsSync(CUSTOMERS_DIR)) return;

  const slugs = fs.readdirSync(CUSTOMERS_DIR).filter(d =>
    fs.statSync(path.join(CUSTOMERS_DIR, d)).isDirectory()
  );

  for (const slug of slugs) {
    try {
      await blobSyncForSlug(slug);
    } catch (err) {
      log(`⚠ [blob-sync] ${slug}: ${err}`);
    }
  }
}

/** Sync blobs for a single customer workspace. */
export async function blobSyncForSlug(slug: string): Promise<void> {
  const customerDir = path.join(CUSTOMERS_DIR, slug);
  const manifestPath = path.join(customerDir, ".files", "manifest.json");
  const blobsDir = path.join(customerDir, ".blobs");
  const syncStatePath = path.join(blobsDir, ".sync-state.json");

  let manifest: Manifest = {};
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch {
      log(`⚠ [blob-sync] ${slug}: failed to parse manifest.json`);
      return;
    }
  } else {
    return;
  }

  fs.mkdirSync(blobsDir, { recursive: true });

  let prevSyncedPaths: string[] = [];
  if (fs.existsSync(syncStatePath)) {
    try {
      prevSyncedPaths = JSON.parse(fs.readFileSync(syncStatePath, "utf-8"));
    } catch { /* ignore corrupt state */ }
  }

  const bucket = getStorage().bucket();
  const manifestPaths = new Set(Object.keys(manifest));
  const prevSet = new Set(prevSyncedPaths);

  // ── Downloads ──────────────────────────────────────────────────────────────
  const downloadQueue: Array<{ blobPath: string; entry: ManifestEntry }> = [];

  for (const [blobPath, entry] of Object.entries(manifest)) {
    if (entry.type !== "blob") continue;
    if (entry.size > BLOB_SYNC_MAX_SIZE) {
      log(`⚠ [blob-sync] ${slug}: skipping ${blobPath} (${(entry.size / 1024 / 1024).toFixed(1)}MB > 100MB)`);
      continue;
    }

    const localPath = path.join(blobsDir, blobPath);
    let needsDownload = !fs.existsSync(localPath);
    if (!needsDownload && entry.uploadedAt) {
      needsDownload = new Date(entry.uploadedAt).getTime() > fs.statSync(localPath).mtimeMs;
    }

    if (needsDownload) {
      downloadQueue.push({ blobPath, entry });
    }
  }

  let downloadCount = 0;
  for (let i = 0; i < downloadQueue.length; i += BLOB_SYNC_MAX_CONCURRENT) {
    const batch = downloadQueue.slice(i, i + BLOB_SYNC_MAX_CONCURRENT);
    await Promise.all(batch.map(async ({ blobPath, entry }) => {
      const localPath = path.join(blobsDir, blobPath);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      try {
        await bucket.file(entry.gcsPath).download({ destination: localPath });
        downloadCount++;
      } catch (err) {
        log(`⚠ [blob-sync] ${slug}: failed to download ${blobPath}: ${err}`);
      }
    }));
  }

  // ── Uploads (agent-created blobs) ──────────────────────────────────────────
  const localBlobs = listFilesRecursive(blobsDir, blobsDir);
  let uploadCount = 0;
  let manifestDirty = false;

  for (const relativePath of localBlobs) {
    if (manifestPaths.has(relativePath) || prevSet.has(relativePath)) continue;

    const localPath = path.join(blobsDir, relativePath);
    const stat = fs.statSync(localPath);
    if (stat.size > BLOB_SYNC_MAX_SIZE) {
      log(`⚠ [blob-sync] ${slug}: skipping upload ${relativePath} (${(stat.size / 1024 / 1024).toFixed(1)}MB > 100MB)`);
      continue;
    }

    const gcsPath = `customers/${slug}/${relativePath}`;
    try {
      await bucket.upload(localPath, { destination: gcsPath });
      const ext = path.extname(relativePath).toLowerCase();
      manifest[relativePath] = {
        type: "blob",
        gcsPath,
        size: stat.size,
        mimeType: MIME_TYPES[ext] || "application/octet-stream",
        uploadedAt: new Date().toISOString(),
      };
      manifestDirty = true;
      uploadCount++;
    } catch (err) {
      log(`⚠ [blob-sync] ${slug}: failed to upload ${relativePath}: ${err}`);
    }
  }

  if (manifestDirty) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  }

  // ── Cleanup (blob deleted via UI → manifest entry removed) ─────────────────
  let cleanupCount = 0;
  for (const prevPath of prevSyncedPaths) {
    if (!manifestPaths.has(prevPath)) {
      const localPath = path.join(blobsDir, prevPath);
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
        cleanupCount++;
      }
    }
  }

  fs.writeFileSync(syncStatePath, JSON.stringify(Object.keys(manifest)), "utf-8");

  if (downloadCount > 0 || uploadCount > 0 || cleanupCount > 0) {
    const parts: string[] = [];
    if (downloadCount) parts.push(`${downloadCount} downloaded`);
    if (uploadCount) parts.push(`${uploadCount} uploaded`);
    if (cleanupCount) parts.push(`${cleanupCount} cleaned up`);
    log(`[blob-sync] ${slug}: ${parts.join(", ")}`);
  } else {
    log(`[blob-sync] ${slug} up to date`);
  }
}
