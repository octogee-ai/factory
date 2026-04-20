/**
 * File upload endpoints — text via Gitea (POST /upload) and binary via GCS
 * + manifest (POST /upload-blob).
 *
 * /upload accepts JSON with a file list + base64 content — authored from
 * the editor UI. /upload-blob is multipart/form-data (Busboy) for images
 * and large files; it also generates a 128px thumbnail for supported
 * image types.
 */
import { Router, Request, Response, NextFunction } from "express";
import Busboy from "busboy";
import { storage } from "../../lib/db";
import { validateFilePath } from "../../lib/path-validation";
import { resolveFileTarget, withFileTarget, type FileTarget } from "../../lib/fileTarget";
import { updateManifest } from "../../lib/manifest";
import { logger } from "../../middleware/logging";
import {
  customerGiteaApi,
  getCustomerGiteaToken,
  getExtension,
  getMimeType,
  HIDDEN,
  IMAGE_EXTENSIONS,
} from "./helpers";

const router = Router();

router.post("/upload", withFileTarget(async (req, res, _next, target) => {
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

    const parts = filePath.split("/");
    if (parts.some((p) => HIDDEN.has(p) || p.startsWith("."))) {
      results.push({ name: filePath, status: "blocked" });
      continue;
    }

    let sha: string | undefined;
    try {
      const existing = (await customerGiteaApi(req, `${repoName}/contents/${filePath}`)) as { sha?: string };
      sha = existing.sha;
    } catch { /* new file */ }

    try {
      await customerGiteaApi(req, `${repoName}/contents/${filePath}`, "PUT", {
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

// ── /upload-blob — multipart binary upload ────────────────────────────────

interface ParsedUpload {
  slug: string;
  projectSlug: string | null;
  path: string;
  fileBuffer: Buffer;
  filename: string;
  mimeType: string;
}

function parseMultipart(req: Request): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const fields: Record<string, string> = {};
    let fileBuffer: Buffer | null = null;
    let filename = "";
    let mimeType = "";

    bb.on("field", (name: string, val: string) => { fields[name] = val; });
    bb.on("file", (_name: string, stream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      filename = info.filename;
      mimeType = info.mimeType;
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => { fileBuffer = Buffer.concat(chunks); });
    });
    bb.on("finish", () => {
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

    // Multipart parsing happens before the route wrapper could run, so
    // resolve the target explicitly here using the parsed fields.
    const targetResult = await resolveFileTarget({
      slug: parsed.slug,
      projectSlug: parsed.projectSlug,
      callerUid: req.uid,
      callerWorkspaceSlug: req.user?.workspaceSlug,
    });
    if (!targetResult.ok) {
      res.status(targetResult.status).json({ error: targetResult.error });
      return;
    }
    const target: FileTarget = targetResult.target;

    const pathError = validateFilePath(filePath);
    if (pathError) { res.status(400).json({ error: pathError }); return; }

    const bucket = storage.bucket();
    const gcsPath = `${target.gcsPrefix}/${filePath}`;
    const ext = getExtension(filePath);

    const file = bucket.file(gcsPath);
    await file.save(fileBuffer, { metadata: { contentType: mimeType || getMimeType(ext) } });

    // Generate thumbnail for images
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

    const { repoName } = target;
    await updateManifest(getCustomerGiteaToken(req), repoName, {
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
