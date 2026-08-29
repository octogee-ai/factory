import { Router, Request, Response, NextFunction } from "express";
import Busboy from "busboy";
import { db, storage } from "../../lib/db.js";
import { validateFilePath } from "../../lib/path-validation.js";
import { resolveFileTarget, withGiteaTarget, type FileTarget } from "../../lib/fileTarget.js";
import {
  storeWorkspaceBlob,
  WorkspaceBlobBusyError,
  WorkspaceStorageQuotaError,
} from "../../lib/workspace-blob.js";
import { freeWorkspaceStorageLimitBytes } from "../../lib/free-storage.js";
import {
  DEFAULT_PLATFORM_FREE_CONFIG,
  PLATFORM_CONFIG_COLLECTION,
  PLATFORM_FREE_CONFIG_DOC,
  parsePlatformFreeConfig,
} from "@octogee/shared/types/platform-config";
import { logger } from "../../middleware/logging.js";
import {
  targetGiteaApi,
  getExtension,
  getMimeType,
  pathHasReservedOrHiddenSegment,
} from "./helpers.js";
import { invalidateWorkspaceFileResponseCache } from "./file-response-cache.js";

const router = Router();

async function uploadStorageLimitBytes(
  userData: FirebaseFirestore.DocumentData | undefined,
  target: FileTarget,
): Promise<number | undefined> {
  const compiledLimit = freeWorkspaceStorageLimitBytes(
    userData ?? {},
    target.projectSlug !== null,
    DEFAULT_PLATFORM_FREE_CONFIG,
  );
  if (compiledLimit === undefined) return undefined;
  const snap = await db
    .collection(PLATFORM_CONFIG_COLLECTION)
    .doc(PLATFORM_FREE_CONFIG_DOC)
    .get();
  const config = parsePlatformFreeConfig(snap.data());
  if (!config) {
    logger.warn("platformConfig/free missing or invalid; using compiled Free storage allowance");
  }
  return freeWorkspaceStorageLimitBytes(
    userData ?? {},
    false,
    config ?? DEFAULT_PLATFORM_FREE_CONFIG,
  );
}

router.post("/upload", withGiteaTarget(async (req, res, _next, target) => {
  const { files } = req.body as {
    files: Array<{ name: string; content: string; path?: string }>;
  };
  if (!files?.length) { res.status(400).json({ error: "Missing files" }); return; }

  const { repoName } = target;
  const results: Array<{ name: string; status: string }> = [];

  let uploaded = false;
  for (const file of files) {
    const filePath = file.path || file.name;
    const pathError = validateFilePath(filePath);
    if (pathError) { results.push({ name: filePath, status: `blocked: ${pathError}` }); continue; }

    if (pathHasReservedOrHiddenSegment(filePath)) {
      results.push({ name: filePath, status: "blocked" });
      continue;
    }

    let sha: string | undefined;
    try {
      const existing = (await targetGiteaApi(target, `${repoName}/contents/${filePath}`)) as { sha?: string };
      sha = existing.sha;
    } catch { /* ignore */ }

    try {
      await targetGiteaApi(target, `${repoName}/contents/${filePath}`, "PUT", {
        message: `upload: ${filePath}`,
        content: file.content,
        ...(sha ? { sha } : {}),
      });
      results.push({ name: filePath, status: "ok" });
      uploaded = true;
    } catch (error) {
      logger.warn("Gitea upload failed", {
        filePath,
        repoName,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({ name: filePath, status: "error" });
    }
  }

  if (uploaded) invalidateWorkspaceFileResponseCache(target);
  res.json({ results });
}, { access: "write" }));

interface ParsedUpload {
  slug: string;
  projectSlug: string | null;
  path: string;
  fileBuffer: Buffer;
  filename: string;
  mimeType: string;
}

const ALLOWED_FIELDS = new Set(["slug", "project", "path"] as const);
type AllowedField = typeof ALLOWED_FIELDS extends Set<infer T> ? T : never;

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export class UploadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`File too large (max ${maxBytes} bytes)`);
    this.name = "UploadTooLargeError";
  }
}

export interface ParseMultipartOpts {
  // upload-blob addresses a repo path, so slug+path fields are mandatory there;
  // issue attachments resolve their target from the query string and name the
  // object from the uploaded file itself.
  requireSlugAndPath?: boolean;
}

export function parseMultipart(
  req: Request,
  maxFileBytes = MAX_UPLOAD_BYTES,
  opts: ParseMultipartOpts = {},
): Promise<ParsedUpload> {
  const requireSlugAndPath = opts.requireSlugAndPath ?? true;
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: maxFileBytes, files: 1 } });
    const fields: Record<string, string> = Object.create(null);
    let fileBuffer: Buffer | null = null;
    let filename = "";
    let mimeType = "";
    let truncated = false;

    bb.on("field", (name: string, val: string) => {
      if (ALLOWED_FIELDS.has(name as AllowedField)) fields[name] = val;
    });
    bb.on("file", (_name: string, stream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      filename = info.filename;
      mimeType = info.mimeType;
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("limit", () => { truncated = true; });
      stream.on("end", () => { fileBuffer = Buffer.concat(chunks); });
    });
    bb.on("finish", () => {
      if (truncated) {
        reject(new UploadTooLargeError(maxFileBytes));
        return;
      }
      if (!fileBuffer || (requireSlugAndPath && (!fields.slug || !fields.path))) {
        reject(new Error(requireSlugAndPath ? "Missing required fields: slug, path, file" : "Missing file"));
        return;
      }
      const path = fields.path ?? "";
      resolve({
        slug: fields.slug ?? "",
        projectSlug: fields.project || null,
        path,
        fileBuffer,
        filename: filename || path.split("/").pop() || "file",
        mimeType: mimeType || getMimeType(getExtension(path || filename)),
      });
    });
    bb.on("error", reject);
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (rawBody) {
      bb.end(rawBody);
    } else {
      req.pipe(bb);
    }
  });
}

router.post("/upload-blob", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = await parseMultipart(req);
    const { path: filePath, fileBuffer, mimeType } = parsed;

    const targetResult = await resolveFileTarget({
      slug: parsed.slug,
      projectSlug: parsed.projectSlug,
      callerUid: req.uid,
      callerWorkspaceSlug: req.workspaceSlug,
    }, { access: "write" });
    if (!targetResult.ok) {
      res.status(targetResult.status).json({ error: targetResult.error });
      return;
    }
    const target: FileTarget = targetResult.target;
    if (target.provider !== "gitea") {
      res.status(409).json({ error: "Not available for GitHub-backed projects", code: "GITHUB_READ_ONLY" });
      return;
    }

    const pathError = validateFilePath(filePath);
    if (pathError) { res.status(400).json({ error: pathError }); return; }

    const maxStorageBytes = await uploadStorageLimitBytes(req.user, target);
    const stored = await storeWorkspaceBlob(
      target,
      filePath,
      fileBuffer,
      mimeType,
      { maxStorageBytes },
    );
    invalidateWorkspaceFileResponseCache(target);

    res.json({
      success: true,
      path: filePath,
      gcsUrl: `gs://${storage.bucket().name}/${stored.gcsPath}`,
      ...(stored.thumbnailUrl ? { thumbnailUrl: stored.thumbnailUrl } : {}),
      ...(stored.thumbnailError ? { thumbnailError: stored.thumbnailError } : {}),
      manifestUpdated: true,
    });
  } catch (e) {
    if (e instanceof WorkspaceBlobBusyError) {
      res.status(409).json({ error: e.message, code: "WORKSPACE_BUSY" });
      return;
    }
    if (e instanceof WorkspaceStorageQuotaError) {
      res.status(413).json({
        error: "Free workspace storage allowance exceeded",
        code: e.code,
        limitBytes: e.limitBytes,
        projectedBytes: e.projectedBytes,
      });
      return;
    }
    next(e);
  }
});

export default router;
