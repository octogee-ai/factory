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
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const MAX_DECOMPRESSED_BYTES = 500 * 1024 * 1024;

type StorageBucket = ReturnType<typeof storage.bucket>;
type StorageFile = ReturnType<StorageBucket["file"]>;
type ExtractedKind = "git" | "blob";

export interface ZipEntryLike {
  dir: boolean;
  async(format: "nodebuffer"): Promise<Buffer>;
}

export interface SafeZipEntry<T extends ZipEntryLike> {
  relativePath: string;
  targetPath: string;
  zipEntry: T;
}

export type ZipEntriesValidation<T extends ZipEntryLike> =
  | { ok: true; entries: Array<SafeZipEntry<T>> }
  | { ok: false; status: 400 | 413; error: string };

interface ExtractZipContext {
  slug: string;
  zipPath: string;
  bucket: StorageBucket;
  zipFile: StorageFile;
  org: string;
  sudoUser: string;
  repoName: string;
}

interface ExtractZipResult {
  gitPaths: string[];
  blobPaths: string[];
  manifestEntries: Record<string, unknown>;
}

interface WrittenEntry {
  kind: ExtractedKind;
  path: string;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function extractedZipBaseDir(zipPath: string): string {
  const zipName = zipPath.split("/").pop()?.replace(/\.zip$/i, "") ?? "extracted";
  return zipPath.includes("/")
    ? zipPath.slice(0, zipPath.lastIndexOf("/") + 1) + zipName
    : zipName;
}

export function validatedZipEntries<T extends ZipEntryLike>(
  zipFiles: Record<string, T>,
  baseDir: string,
): ZipEntriesValidation<T> {
  const fileEntries = Object.entries(zipFiles).filter(([, entry]) => !entry.dir);
  if (fileEntries.length > MAX_ENTRIES) {
    return {
      ok: false,
      status: 413,
      error: `Archive has ${fileEntries.length} entries (max ${MAX_ENTRIES})`,
    };
  }

  const entries: Array<SafeZipEntry<T>> = [];
  for (const [relativePath, zipEntry] of fileEntries) {
    if (relativePath.startsWith("__MACOSX/") || relativePath.includes("/.DS_Store")) continue;

    const targetPath = `${baseDir}/${relativePath}`;
    const targetPathError = validateWorkspacePath(targetPath);
    if (targetPathError) {
      return {
        ok: false,
        status: 400,
        error: `Blocked entry "${relativePath}": ${targetPathError}`,
      };
    }

    entries.push({ relativePath, targetPath, zipEntry });
  }

  return { ok: true, entries };
}

function extractZipContext(slug: string, zipPath: string): ExtractZipContext {
  const bucket = storage.bucket();
  const gcsZipPath = `customers/${slug}/${zipPath}`;
  return {
    slug,
    zipPath,
    bucket,
    zipFile: bucket.file(gcsZipPath),
    org: workspaceGiteaOrg(slug),
    sudoUser: `ws-${slug}`,
    repoName: workspaceRepoName(),
  };
}

function requestZipPath(req: Request, res: Response): string | null {
  const { zipPath } = req.body as { zipPath: string };
  if (!zipPath) {
    res.status(400).json({ error: "Missing zipPath" });
    return null;
  }

  const zipPathError = validateWorkspacePath(zipPath);
  if (zipPathError) {
    res.status(400).json({ error: `Invalid zipPath: ${zipPathError}` });
    return null;
  }

  return zipPath;
}

async function loadZipArchive(context: ExtractZipContext, res: Response): Promise<JSZip | null> {
  const [zipBuffer] = await context.zipFile.download();
  if (zipBuffer.length > MAX_ARCHIVE_BYTES) {
    res.status(413).json({ error: "Archive exceeds 200MB limit" });
    return null;
  }

  // eslint-disable-next-line sonarjs/no-unsafe-unzip -- size capped above; per-entry cap enforced before writes
  return JSZip.loadAsync(zipBuffer);
}

async function existingTextSha(context: ExtractZipContext, targetPath: string): Promise<string | undefined> {
  try {
    const existing = (await giteaApiAsUser(
      context.sudoUser,
      context.org,
      `${context.repoName}/contents/${targetPath}`,
    )) as { sha?: string };
    return existing.sha;
  } catch (e) {
    if (errorMessage(e).includes("404")) return undefined;
    logger.warn(`Failed to read existing ZIP entry SHA for ${targetPath}: ${errorMessage(e)}`);
    return undefined;
  }
}

async function writeTextEntry(
  context: ExtractZipContext,
  entry: SafeZipEntry<ZipEntryLike>,
  fileBuffer: Buffer,
): Promise<WrittenEntry> {
  const sha = await existingTextSha(context, entry.targetPath);
  await giteaApiAsUser(context.sudoUser, context.org, `${context.repoName}/contents/${entry.targetPath}`, "PUT", {
    message: `zip-extract: ${entry.relativePath}`,
    content: fileBuffer.toString("base64"),
    ...(sha ? { sha } : {}),
  });

  return { kind: "git", path: entry.targetPath };
}

async function writeBlobEntry(
  context: ExtractZipContext,
  entry: SafeZipEntry<ZipEntryLike>,
  fileBuffer: Buffer,
  manifestEntries: Record<string, unknown>,
): Promise<WrittenEntry> {
  const ext = getExtension(entry.relativePath);
  const gcsPath = `customers/${context.slug}/${entry.targetPath}`;
  const mimeType = getMimeType(ext);
  await context.bucket.file(gcsPath).save(fileBuffer, { metadata: { contentType: mimeType } });
  manifestEntries[entry.targetPath] = {
    type: "blob",
    gcsPath,
    size: fileBuffer.length,
    mimeType,
    uploadedAt: new Date().toISOString(),
  };

  return { kind: "blob", path: entry.targetPath };
}

async function writeExtractedEntry(
  context: ExtractZipContext,
  entry: SafeZipEntry<ZipEntryLike>,
  fileBuffer: Buffer,
  manifestEntries: Record<string, unknown>,
): Promise<WrittenEntry> {
  if (isTextFile(entry.relativePath)) {
    return writeTextEntry(context, entry, fileBuffer);
  }

  return writeBlobEntry(context, entry, fileBuffer, manifestEntries);
}

function entrySizeError(relativePath: string, fileSize: number, totalSize: number): string | null {
  if (fileSize > MAX_ENTRY_BYTES) {
    return `Entry "${relativePath}" exceeds ${MAX_ENTRY_BYTES} bytes`;
  }

  if (totalSize > MAX_DECOMPRESSED_BYTES) {
    return `Total decompressed size exceeds ${MAX_DECOMPRESSED_BYTES} bytes`;
  }

  return null;
}

async function extractEntries(
  context: ExtractZipContext,
  entries: Array<SafeZipEntry<ZipEntryLike>>,
  res: Response,
): Promise<ExtractZipResult | null> {
  const result: ExtractZipResult = { gitPaths: [], blobPaths: [], manifestEntries: {} };
  let totalDecompressedBytes = 0;

  for (const entry of entries) {
    const fileBuffer = await entry.zipEntry.async("nodebuffer");
    totalDecompressedBytes += fileBuffer.length;

    const sizeError = entrySizeError(entry.relativePath, fileBuffer.length, totalDecompressedBytes);
    if (sizeError) {
      res.status(413).json({ error: sizeError });
      return null;
    }

    const written = await writeExtractedEntry(context, entry, fileBuffer, result.manifestEntries);
    if (written.kind === "git") {
      result.gitPaths.push(written.path);
    } else {
      result.blobPaths.push(written.path);
    }
  }

  return result;
}

async function deleteOriginalZip(context: ExtractZipContext): Promise<void> {
  try {
    await context.zipFile.delete();
  } catch (e) {
    logger.warn(`Failed to delete ZIP after extraction: ${errorMessage(e)}`);
  }
}

async function finalizeExtraction(context: ExtractZipContext, result: ExtractZipResult): Promise<void> {
  if (Object.keys(result.manifestEntries).length > 0) {
    await updateManifest(context.sudoUser, context.org, context.repoName, result.manifestEntries);
  }

  await deleteOriginalZip(context);
  await removeFromManifest(
    context.sudoUser,
    context.org,
    context.repoName,
    context.zipPath,
    `blob: remove extracted zip ${context.zipPath} from manifest`,
  );
}

async function extractZip(req: Request, res: Response): Promise<void> {
  const slug = ensureSlug(req, res);
  if (!slug) return;

  const zipPath = requestZipPath(req, res);
  if (!zipPath) return;

  const context = extractZipContext(slug, zipPath);
  const zip = await loadZipArchive(context, res);
  if (!zip) return;

  const validation = validatedZipEntries(zip.files, extractedZipBaseDir(zipPath));
  if (!validation.ok) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }

  const result = await extractEntries(context, validation.entries, res);
  if (!result) return;

  await finalizeExtraction(context, result);
  res.json({ success: true, extracted: { git: result.gitPaths, blob: result.blobPaths } });
}

router.post("/extract-zip", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await extractZip(req, res);
  } catch (e) {
    next(e);
  }
});

export default router;
