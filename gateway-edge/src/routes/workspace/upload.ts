import { Router, Request, Response, NextFunction } from "express";
import Busboy from "busboy";
import { storage } from "../../lib/db.js";
import { validateFilePath } from "../../lib/path-validation.js";
import { resolveFileTarget, withGiteaTarget, type FileTarget } from "../../lib/fileTarget.js";
import { updateManifest } from "../../lib/manifest.js";
import { logger } from "../../middleware/logging.js";
import {
  targetGiteaApi,
  giteaSudoUser,
  getExtension,
  getMimeType,
  IMAGE_EXTENSIONS,
  pathHasReservedOrHiddenSegment,
} from "./helpers.js";

const router = Router();

router.post("/upload", withGiteaTarget(async (req, res, _next, target) => {
  const { files } = req.body as {
    files: Array<{ name: string; content: string; path?: string }>;
  };
  if (!files?.length) { res.status(400).json({ error: "Missing files" }); return; }

  const { repoName } = target;
  const results: Array<{ name: string; status: string }> = [];

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
    } catch (error) {
      logger.warn("Gitea upload failed", {
        filePath,
        repoName,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({ name: filePath, status: "error" });
    }
  }

  res.json({ results });
}));

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

export function parseMultipart(
  req: Request,
  maxFileBytes = MAX_UPLOAD_BYTES,
): Promise<ParsedUpload> {
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
        reject(new Error(`File too large (max ${maxFileBytes} bytes)`));
        return;
      }
      if (!fields.slug || !fields.path || !fileBuffer) {
        reject(new Error("Missing required fields: slug, path, file"));
        return;
      }
      resolve({
        slug: fields.slug,
        projectSlug: fields.project || null,
        path: fields.path,
        fileBuffer,
        filename: filename || fields.path.split("/").pop() || "file",
        mimeType: mimeType || getMimeType(getExtension(fields.path)),
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
    });
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

    const bucket = storage.bucket();
    const gcsPath = `${target.gcsPrefix}/${filePath}`;
    const ext = getExtension(filePath);

    const file = bucket.file(gcsPath);
    await file.save(fileBuffer, { metadata: { contentType: mimeType || getMimeType(ext) } });

    let thumbnailUrl: string | undefined;
    let thumbnailError: string | undefined;
    if (IMAGE_EXTENSIONS.has(ext)) {
      try {
        const sharp = (await import("sharp")).default;
        const thumbBuffer = await sharp(fileBuffer).resize(128, 128, { fit: "inside" }).png().toBuffer();
        const thumbPath = `${target.gcsPrefix}/.thumbs/${filePath}.png`;
        const thumbFile = bucket.file(thumbPath);
        await thumbFile.save(thumbBuffer, { metadata: { contentType: "image/png" } });
        const [signedUrl] = await thumbFile.getSignedUrl({
          action: "read",
          expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        thumbnailUrl = signedUrl;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(`Thumbnail generation failed for ${filePath}: ${msg}`);
        thumbnailError = msg;
      }
    }

    const { org, repoName } = target;
    await updateManifest(giteaSudoUser(target), org, repoName, {
      [filePath]: {
        type: "blob",
        gcsPath,
        size: fileBuffer.length,
        mimeType: mimeType || getMimeType(ext),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        uploadedAt: new Date().toISOString(),
      },
    });

    res.json({
      success: true,
      path: filePath,
      gcsUrl: `gs://${bucket.name}/${gcsPath}`,
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(thumbnailError ? { thumbnailError } : {}),
      manifestUpdated: true,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
