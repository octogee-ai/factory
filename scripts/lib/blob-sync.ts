import * as fs from "fs";
import * as path from "path";
import { log, CUSTOMERS_DIR, BLOB_SYNC_MAX_CONCURRENT, BLOB_SYNC_MAX_SIZE } from "./config.js";
import { MIME_TYPES } from "./helpers.js";

export interface ManifestEntry {
  type: "blob";
  gcsPath: string;
  size: number;
  mimeType: string;
  thumbnailUrl?: string;
  uploadedAt: string;
}

export type Manifest = Record<string, ManifestEntry>;

export interface LocalFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface BlobStore {
  download(input: {
    slug: string;
    relativePath: string;
    gcsPath: string;
    destination: string;
  }): Promise<void>;
  upload(input: {
    slug: string;
    relativePath: string;
    gcsPath: string;
    localPath: string;
    mimeType: string;
    size: number;
  }): Promise<void>;
}

export type BlobStoreFactory = (slug: string) => BlobStore | Promise<BlobStore>;

export interface BlobSyncOptions {
  store?: BlobStore;
}

export interface BlobSyncAllOptions {
  storeForSlug?: BlobStoreFactory;
}

export interface BlobSyncActions {
  toDownload: Array<{ path: string; entry: ManifestEntry }>;
  toUpload: string[];
  toDelete: string[];
  skippedDownload: Array<{ path: string; size: number }>;
  skippedUpload: Array<{ path: string; size: number }>;
}

export interface BlobSyncInputs {
  manifest: Manifest;
  localFiles: LocalFile[];
  prevSyncedPaths: string[];
  maxSize?: number;
}

export function computeBlobSyncActions(inputs: BlobSyncInputs): BlobSyncActions {
  const { manifest, localFiles, prevSyncedPaths, maxSize = BLOB_SYNC_MAX_SIZE } = inputs;

  const toDownload: BlobSyncActions["toDownload"] = [];
  const toUpload: string[] = [];
  const toDelete: string[] = [];
  const skippedDownload: BlobSyncActions["skippedDownload"] = [];
  const skippedUpload: BlobSyncActions["skippedUpload"] = [];

const blobEntries = Object.entries(manifest).filter(([, e]) => e.type === "blob");
  const manifestBlobPaths = new Set(blobEntries.map(([p]) => p));
  const prevSet = new Set(prevSyncedPaths);
  const localByPath = new Map(localFiles.map(f => [f.path, f] as const));

  for (const [blobPath, entry] of blobEntries) {
    if (entry.size > maxSize) {
      skippedDownload.push({ path: blobPath, size: entry.size });
      continue;
    }
    const local = localByPath.get(blobPath);
    if (!local || new Date(entry.uploadedAt).getTime() > local.mtimeMs) {
      toDownload.push({ path: blobPath, entry });
    }
  }

  for (const local of localFiles) {
    if (manifestBlobPaths.has(local.path) || prevSet.has(local.path)) continue;
    if (local.size > maxSize) {
      skippedUpload.push({ path: local.path, size: local.size });
      continue;
    }
    toUpload.push(local.path);
  }

  for (const prevPath of prevSyncedPaths) {
    if (!manifestBlobPaths.has(prevPath) && localByPath.has(prevPath)) {
      toDelete.push(prevPath);
    }
  }

  return { toDownload, toUpload, toDelete, skippedDownload, skippedUpload };
}

function pathExists(p: string): boolean {
  return fs.existsSync(p);
}

function readJsonOrLog<T>(filePath: string, slug: string, label: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    log(`⚠ [blob-sync] ${slug}: failed to parse ${label}`);
    return null;
  }
}

function readJsonOrEmpty<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function mkdirP(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, "utf-8");
}

function unlinkIfExists(filePath: string): boolean {
  if (!pathExists(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

function statOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function mimeTypeForPath(relativePath: string): string {
  const ext = path.extname(relativePath).toLowerCase();
  return Object.prototype.hasOwnProperty.call(MIME_TYPES, ext)
    ? MIME_TYPES[ext as keyof typeof MIME_TYPES]
    : "application/octet-stream";
}

export function listFilesRecursive(dir: string, base: string): string[] {
  if (!pathExists(dir)) return [];
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

function discoverLocalFiles(blobsDir: string): LocalFile[] {
  const relPaths = listFilesRecursive(blobsDir, blobsDir);
  const files: LocalFile[] = [];
  for (const rel of relPaths) {
    const stats = statOrNull(path.join(blobsDir, rel));
    if (!stats) continue;
    files.push({ path: rel, mtimeMs: stats.mtimeMs, size: stats.size });
  }
  return files;
}

function recordUpload(
  manifest: Manifest,
  relativePath: string,
  slug: string,
  size: number,
): void {
  const mimeType = mimeTypeForPath(relativePath);
  Object.defineProperty(manifest, relativePath, {
    value: {
      type: "blob",
      gcsPath: `customers/${slug}/${relativePath}`,
      size,
      mimeType,
      uploadedAt: new Date().toISOString(),
    },
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

async function firebaseAdminBlobStore(): Promise<BlobStore> {
  const { getStorage } = await import("firebase-admin/storage");
  const bucket = getStorage().bucket();
  return {
    async download(input) {
      await bucket.file(input.gcsPath).download({ destination: input.destination });
    },
    async upload(input) {
      await bucket.upload(input.localPath, { destination: input.gcsPath });
    },
  };
}

export async function blobSyncAll(): Promise<void> {
  return blobSyncAllWithOptions();
}

export async function blobSyncAllWithOptions(opts: BlobSyncAllOptions = {}): Promise<void> {
  if (!pathExists(CUSTOMERS_DIR)) return;

  const slugs = fs.readdirSync(CUSTOMERS_DIR).filter(d => {
    return fs.statSync(path.join(CUSTOMERS_DIR, d)).isDirectory();
  });

  for (const slug of slugs) {
    try {
      await blobSyncForSlug(slug, {
        store: opts.storeForSlug ? await opts.storeForSlug(slug) : undefined,
      });
    } catch (err) {
      log(`⚠ [blob-sync] ${slug}: ${err}`);
    }
  }
}

function loadManifest(slug: string, manifestPath: string): Manifest | null {
  if (!pathExists(manifestPath)) return null;
  return readJsonOrLog<Manifest>(manifestPath, slug, "manifest.json");
}

function loadPrevSyncState(syncStatePath: string): string[] {
  if (!pathExists(syncStatePath)) return [];
  return readJsonOrEmpty<string[]>(syncStatePath) ?? [];
}

interface SyncPaths {
  customerDir: string;
  manifestPath: string;
  blobsDir: string;
  syncStatePath: string;
}

function pathsForSlug(slug: string): SyncPaths {
  const customerDir = path.join(CUSTOMERS_DIR, slug);
  const blobsDir = path.join(customerDir, ".blobs");
  return {
    customerDir,
    manifestPath: path.join(customerDir, ".files", "manifest.json"),
    blobsDir,
    syncStatePath: path.join(blobsDir, ".sync-state.json"),
  };
}

export async function blobSyncForSlug(slug: string, opts: BlobSyncOptions = {}): Promise<void> {
  const paths = pathsForSlug(slug);

  const manifest = loadManifest(slug, paths.manifestPath);
  if (manifest === null) return;

  mkdirP(paths.blobsDir);

  const prevSyncedPaths = loadPrevSyncState(paths.syncStatePath);
  const localFiles = discoverLocalFiles(paths.blobsDir);
  const actions = computeBlobSyncActions({ manifest, localFiles, prevSyncedPaths });

  for (const { path: p, size } of actions.skippedDownload) {
    log(`⚠ [blob-sync] ${slug}: skipping ${p} (${mb(size)}MB > ${mb(BLOB_SYNC_MAX_SIZE)}MB)`);
  }
  for (const { path: p, size } of actions.skippedUpload) {
    log(`⚠ [blob-sync] ${slug}: skipping upload ${p} (${mb(size)}MB > ${mb(BLOB_SYNC_MAX_SIZE)}MB)`);
  }

  const store = opts.store ?? await firebaseAdminBlobStore();
  const downloadCount = await runDownloads(slug, paths.blobsDir, actions.toDownload, store);
  const uploadCount = await runUploads(slug, paths.blobsDir, actions.toUpload, manifest, store);
  const cleanupCount = runCleanup(paths.blobsDir, actions.toDelete);

  if (uploadCount > 0) {
    mkdirP(path.dirname(paths.manifestPath));
    writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  writeFile(paths.syncStatePath, JSON.stringify(Object.keys(manifest)));

  logSummary(slug, { downloadCount, uploadCount, cleanupCount });
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

async function runDownloads(
  slug: string,
  blobsDir: string,
  queue: BlobSyncActions["toDownload"],
  store: BlobStore,
): Promise<number> {
  let count = 0;
  for (let i = 0; i < queue.length; i += BLOB_SYNC_MAX_CONCURRENT) {
    const batch = queue.slice(i, i + BLOB_SYNC_MAX_CONCURRENT);
    await Promise.all(batch.map(async ({ path: blobPath, entry }) => {
      const localPath = path.join(blobsDir, blobPath);
      mkdirP(path.dirname(localPath));
      try {
        await store.download({
          slug,
          relativePath: blobPath,
          gcsPath: entry.gcsPath,
          destination: localPath,
        });
        count++;
      } catch (err) {
        log(`⚠ [blob-sync] ${slug}: failed to download ${blobPath}: ${err}`);
      }
    }));
  }
  return count;
}

async function runUploads(
  slug: string,
  blobsDir: string,
  queue: string[],
  manifest: Manifest,
  store: BlobStore,
): Promise<number> {
  let count = 0;
  for (const relativePath of queue) {
    const localPath = path.join(blobsDir, relativePath);
    const stats = statOrNull(localPath);
    if (!stats) continue;
    const gcsPath = `customers/${slug}/${relativePath}`;
    const mimeType = mimeTypeForPath(relativePath);
    try {
      await store.upload({ slug, relativePath, gcsPath, localPath, mimeType, size: stats.size });
      recordUpload(manifest, relativePath, slug, stats.size);
      count++;
    } catch (err) {
      log(`⚠ [blob-sync] ${slug}: failed to upload ${relativePath}: ${err}`);
    }
  }
  return count;
}

function runCleanup(blobsDir: string, toDelete: string[]): number {
  let count = 0;
  for (const relativePath of toDelete) {
    if (unlinkIfExists(path.join(blobsDir, relativePath))) count++;
  }
  return count;
}

function logSummary(
  slug: string,
  counts: { downloadCount: number; uploadCount: number; cleanupCount: number },
): void {
  if (counts.downloadCount === 0 && counts.uploadCount === 0 && counts.cleanupCount === 0) {
    log(`[blob-sync] ${slug} up to date`);
    return;
  }
  const parts: string[] = [];
  if (counts.downloadCount) parts.push(`${counts.downloadCount} downloaded`);
  if (counts.uploadCount) parts.push(`${counts.uploadCount} uploaded`);
  if (counts.cleanupCount) parts.push(`${counts.cleanupCount} cleaned up`);
  log(`[blob-sync] ${slug}: ${parts.join(", ")}`);
}
