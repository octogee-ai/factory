import * as fs from "fs";
import * as path from "path";
import {
  putManifestEntries,
  readManifest,
  type Manifest,
  type ManifestEntry,
  type ManifestStore,
} from "@octogee/core/workspace-manifest";
import { acquireWorkspaceMutationLeaseSync } from "@octogee/core/workspace-mutation-lease";
import {
  log,
  CUSTOMERS_DIR,
  OPENCLAW_DIR,
  BLOB_SYNC_MAX_CONCURRENT,
  BLOB_SYNC_MAX_SIZE,
} from "./config.js";
import { MIME_TYPES } from "./helpers.js";

export type { Manifest, ManifestEntry };

export const PENDING_BLOB_UPLOAD_DIR = ".pending";

export interface LocalFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface BlobStore {
  manifestFor(slug: string): ManifestStore;
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
  strict?: boolean;
  acquireWorkspaceMutationLease?: (workspaceDir: string) => { release(): void } | null;
}

export interface BlobSyncAllOptions {
  storeForSlug?: BlobStoreFactory;
  strict?: boolean;
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
  pendingLocalFiles?: LocalFile[];
  maxSize?: number;
}

type ManifestBlobAction = "download" | "upload" | "skip-download" | "skip-upload" | "skip";

function manifestBlobAction(
  entry: ManifestEntry,
  local: LocalFile | undefined,
  pending: LocalFile | undefined,
  maxSize: number,
): ManifestBlobAction {
  if (pending) return pending.size > maxSize ? "skip-upload" : "upload";
  if (entry.size > maxSize) return "skip-download";
  return !local || new Date(entry.uploadedAt).getTime() > local.mtimeMs ? "download" : "skip";
}

interface NewBlobQueueInputs {
  files: LocalFile[];
  manifestBlobPaths: Set<string>;
  prevSyncedPaths: Set<string>;
  maxSize: number;
  toUpload: string[];
  skippedUpload: BlobSyncActions["skippedUpload"];
}

function queueNewBlobFiles({
  files,
  manifestBlobPaths,
  prevSyncedPaths,
  maxSize,
  toUpload,
  skippedUpload,
}: NewBlobQueueInputs): void {
  for (const file of files) {
    if (manifestBlobPaths.has(file.path) || prevSyncedPaths.has(file.path)) continue;
    if (file.size > maxSize) {
      skippedUpload.push({ path: file.path, size: file.size });
    } else {
      toUpload.push(file.path);
    }
  }
}

export function computeBlobSyncActions(inputs: BlobSyncInputs): BlobSyncActions {
  const {
    manifest,
    localFiles,
    prevSyncedPaths,
    pendingLocalFiles = [],
    maxSize = BLOB_SYNC_MAX_SIZE,
  } = inputs;

  const toDownload: BlobSyncActions["toDownload"] = [];
  const toUpload: string[] = [];
  const toDelete: string[] = [];
  const skippedDownload: BlobSyncActions["skippedDownload"] = [];
  const skippedUpload: BlobSyncActions["skippedUpload"] = [];

  const blobEntries = Object.entries(manifest).filter(([, e]) => e.type === "blob");
  const manifestBlobPaths = new Set(blobEntries.map(([p]) => p));
  const prevSet = new Set(prevSyncedPaths);
  const pendingByPath = new Map(pendingLocalFiles.map((file) => [file.path, file] as const));
  const localByPath = new Map(localFiles.map(f => [f.path, f] as const));

  for (const [blobPath, entry] of blobEntries) {
    const local = localByPath.get(blobPath);
    const pending = pendingByPath.get(blobPath);
    const action = manifestBlobAction(entry, local, pending, maxSize);
    if (action === "upload") {
      toUpload.push(blobPath);
    } else if (action === "skip-upload") {
      skippedUpload.push({ path: blobPath, size: pending!.size });
    } else if (action === "skip-download") {
      skippedDownload.push({ path: blobPath, size: entry.size });
    } else if (action === "download") {
      toDownload.push({ path: blobPath, entry });
    }
  }

  queueNewBlobFiles({
    files: localFiles,
    manifestBlobPaths,
    prevSyncedPaths: prevSet,
    maxSize,
    toUpload,
    skippedUpload,
  });
  queueNewBlobFiles({
    files: pendingLocalFiles,
    manifestBlobPaths,
    prevSyncedPaths: new Set(),
    maxSize,
    toUpload,
    skippedUpload,
  });

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

function isPendingBlobPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    return false;
  }
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith("."));
}

export function stageBlobUpload(repoDir: string, relativePath: string): void {
  if (!isPendingBlobPath(relativePath)) throw new Error(`invalid blob path: ${relativePath}`);
  const source = path.join(repoDir, relativePath);
  const pendingPath = path.join(repoDir, ".blobs", PENDING_BLOB_UPLOAD_DIR, relativePath);
  mkdirP(path.dirname(pendingPath));
  fs.renameSync(source, pendingPath);
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
  const { createGcsManifestStore } = await import("@octogee/core/workspace-manifest");
  const bucket = getStorage().bucket();
  return {
    manifestFor: () => createGcsManifestStore(bucket),
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

  const failures: string[] = [];
  for (const slug of slugs) {
    try {
      await blobSyncForSlug(slug, {
        store: opts.storeForSlug ? await opts.storeForSlug(slug) : undefined,
        strict: opts.strict,
      });
    } catch (err) {
      log(`⚠ [blob-sync] ${slug}: ${err}`);
      failures.push(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (opts.strict && failures.length > 0) {
    throw new Error(`[blob-sync] durable flush failed: ${failures.join("; ")}`);
  }
}

function loadPrevSyncState(syncStatePath: string): string[] {
  if (!pathExists(syncStatePath)) return [];
  return readJsonOrEmpty<string[]>(syncStatePath) ?? [];
}

interface SyncPaths {
  customerDir: string;
  blobsDir: string;
  syncStatePath: string;
}

export function gcsPrefixForSlug(slug: string): string {
  return `customers/${slug}`;
}

function pathsForSlug(slug: string): SyncPaths {
  const customerDir = path.join(CUSTOMERS_DIR, slug);
  const blobsDir = path.join(customerDir, ".blobs");
  return {
    customerDir,
    blobsDir,
    syncStatePath: path.join(blobsDir, ".sync-state.json"),
  };
}

export async function blobSyncForSlug(slug: string, opts: BlobSyncOptions = {}): Promise<void> {
  const paths = pathsForSlug(slug);
  const lease = acquireBlobSyncLease(paths.customerDir, slug, opts.acquireWorkspaceMutationLease);
  if (!lease) throw new Error(`${slug}: workspace mutation lease unavailable`);
  try {
    await syncBlobTarget(slug, paths, opts);
  } finally {
    lease.release();
  }
}

function acquireBlobSyncLease(
  customerDir: string,
  slug: string,
  acquire: BlobSyncOptions["acquireWorkspaceMutationLease"],
): { release(): void } | null {
  if (acquire) return acquire(customerDir);
  const metadataDir = path.join(OPENCLAW_DIR, "git-metadata", slug, "workspace.git");
  const gitDir = pathExists(metadataDir) ? metadataDir : path.join(customerDir, ".git");
  if (!pathExists(gitDir)) return { release: () => {} };
  return acquireWorkspaceMutationLeaseSync({ workspaceDir: customerDir, gitDir });
}

async function syncBlobTarget(
  slug: string,
  paths: SyncPaths,
  opts: BlobSyncOptions,
): Promise<void> {
  const store = opts.store ?? await firebaseAdminBlobStore();
  const manifestStore = store.manifestFor(slug);
  const manifest = await readManifest(manifestStore, gcsPrefixForSlug(slug));

  mkdirP(paths.blobsDir);

  const prevSyncedPaths = loadPrevSyncState(paths.syncStatePath);
  const localFiles = discoverLocalFiles(paths.blobsDir);
  const pendingDir = path.join(paths.blobsDir, PENDING_BLOB_UPLOAD_DIR);
  const pendingLocalFiles = discoverLocalFiles(pendingDir);
  const actions = computeBlobSyncActions({ manifest, localFiles, prevSyncedPaths, pendingLocalFiles });

  for (const { path: p, size } of actions.skippedDownload) {
    log(`⚠ [blob-sync] ${slug}: skipping ${p} (${mb(size)}MB > ${mb(BLOB_SYNC_MAX_SIZE)}MB)`);
  }
  for (const { path: p, size } of actions.skippedUpload) {
    log(`⚠ [blob-sync] ${slug}: skipping upload ${p} (${mb(size)}MB > ${mb(BLOB_SYNC_MAX_SIZE)}MB)`);
  }

  const downloads = await runDownloads(slug, paths.blobsDir, actions.toDownload, store);
  const pendingPaths = new Set(pendingLocalFiles.map((file) => file.path));
  const uploads = await runUploads({
    slug,
    blobsDir: paths.blobsDir,
    pendingDir,
    queue: actions.toUpload,
    pendingPaths,
    store,
  });
  const failures = [...downloads.failures, ...uploads.failures];
  if (opts.strict && failures.length > 0) {
    throw new Error(failures.join("; "));
  }
  const cleanupCount = runCleanup(paths.blobsDir, actions.toDelete);

  if (uploads.count > 0) {
    await putManifestEntries(manifestStore, gcsPrefixForSlug(slug), uploads.recorded);
    Object.assign(manifest, uploads.recorded);
  }
  promotePendingUploads(pendingDir, paths.blobsDir, uploads.pendingPaths);
  writeFile(paths.syncStatePath, JSON.stringify(Object.keys(manifest)));

  logSummary(slug, {
    downloadCount: downloads.count,
    uploadCount: uploads.count,
    cleanupCount,
  });
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

async function runDownloads(
  slug: string,
  blobsDir: string,
  queue: BlobSyncActions["toDownload"],
  store: BlobStore,
): Promise<{ count: number; failures: string[] }> {
  let count = 0;
  const failures: string[] = [];
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
        failures.push(`download ${blobPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }));
  }
  return { count, failures };
}

interface UploadInputs {
  slug: string;
  blobsDir: string;
  pendingDir: string;
  queue: string[];
  pendingPaths: Set<string>;
  store: BlobStore;
}

async function runUploads({
  slug,
  blobsDir,
  pendingDir,
  queue,
  pendingPaths,
  store,
}: UploadInputs,
): Promise<{ count: number; pendingPaths: string[]; failures: string[]; recorded: Manifest }> {
  let count = 0;
  const uploadedPendingPaths: string[] = [];
  const failures: string[] = [];
  const recorded: Manifest = {};
  for (const relativePath of queue) {
    const pending = pendingPaths.has(relativePath);
    const localPath = path.join(pending ? pendingDir : blobsDir, relativePath);
    const stats = statOrNull(localPath);
    if (!stats) continue;
    const gcsPath = `customers/${slug}/${relativePath}`;
    const mimeType = mimeTypeForPath(relativePath);
    try {
      await store.upload({ slug, relativePath, gcsPath, localPath, mimeType, size: stats.size });
      recordUpload(recorded, relativePath, slug, stats.size);
      count++;
      if (pending) uploadedPendingPaths.push(relativePath);
    } catch (err) {
      log(`⚠ [blob-sync] ${slug}: failed to upload ${relativePath}: ${err}`);
      failures.push(`upload ${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { count, pendingPaths: uploadedPendingPaths, failures, recorded };
}

function promotePendingUploads(pendingDir: string, blobsDir: string, paths: string[]): void {
  for (const relativePath of paths) {
    const pendingPath = path.join(pendingDir, relativePath);
    if (!pathExists(pendingPath)) continue;
    const destination = path.join(blobsDir, relativePath);
    mkdirP(path.dirname(destination));
    fs.renameSync(pendingPath, destination);
  }
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
