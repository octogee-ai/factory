import { Router, type Request, type Response } from "express";
import { withFileTarget, type FileTarget } from "../../lib/fileTarget.js";
import { githubContentsApi, githubContentsPut } from "../../lib/github.js";
import {
  isBrokeredWritablePath,
  isTextFile,
  resolveCommitAuthor,
  targetGiteaApi,
  validateWorkspacePath,
} from "./helpers.js";
import { logger } from "../../middleware/logging.js";

const router = Router();

const MAX_SAVE_BYTES = 1024 * 1024;

export type ValidatedSaveRequest =
  | { ok: true; path: string; content: string }
  | { ok: false; status: 400 | 413; error: string; code?: string };

type SaveAuthor = ReturnType<typeof resolveCommitAuthor>;

interface SavePayload {
  author: SaveAuthor;
  contentBase64: string;
  message: string;
  start: number;
}

function commitMessage(path: string, authorName: string): string {
  const kind = path.startsWith("notes/") ? "notes" : "canvas";
  return `${kind}: edit ${path} — ${authorName} via Octogee Canvas`;
}

function rethrowUnlessNotFound(e: unknown): undefined {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("404")) return undefined;
  throw e;
}

export function validatedSaveRequest(body: unknown): ValidatedSaveRequest {
  const { path, content } = body && typeof body === "object"
    ? body as { path?: unknown; content?: unknown }
    : {};
  const savePath = typeof path === "string" ? path : "";
  const saveContent = typeof content === "string" ? content : null;
  if (!savePath) return { ok: false, status: 400, error: "Missing path" };
  if (saveContent === null) return { ok: false, status: 400, error: "Missing content" };

  const pathError = validateWorkspacePath(savePath);
  if (pathError) return { ok: false, status: 400, error: pathError };
  if (!isTextFile(savePath)) {
    return { ok: false, status: 400, error: "Only text files can be saved", code: "NOT_TEXT" };
  }
  if (Buffer.byteLength(saveContent, "utf8") > MAX_SAVE_BYTES) {
    return { ok: false, status: 413, error: "Content too large", code: "TOO_LARGE" };
  }

  return { ok: true, path: savePath, content: saveContent };
}

function sendValidationError(res: Response, validation: Extract<ValidatedSaveRequest, { ok: false }>): void {
  res.status(validation.status).json({
    error: validation.error,
    ...(validation.code ? { code: validation.code } : {}),
  });
}

function sendBrokeredPathError(res: Response): void {
  res.status(403).json({
    error: "Only notes and the canvas home file are writable with a brokered token",
    code: "PATH_NOT_WRITABLE",
  });
}

function savePayload(
  req: Request,
  target: FileTarget,
  request: Extract<ValidatedSaveRequest, { ok: true }>,
): SavePayload {
  const author = resolveCommitAuthor(req.user, target.slug);
  return {
    author,
    contentBase64: Buffer.from(request.content, "utf8").toString("base64"),
    message: commitMessage(request.path, author.name),
    start: Date.now(),
  };
}

async function githubSha(target: FileTarget, path: string): Promise<string | undefined> {
  try {
    const existing = (await githubContentsApi(
      target.org, target.repoName, path, target.githubToken,
    )) as { sha?: string };
    return existing.sha;
  } catch (e) {
    return rethrowUnlessNotFound(e);
  }
}

async function saveGithub(
  target: FileTarget,
  request: Extract<ValidatedSaveRequest, { ok: true }>,
  payload: SavePayload,
): Promise<{ ok: true; sha: string | null; provider: "github" }> {
  const sha = await githubSha(target, request.path);
  const out = (await githubContentsPut(target.org, target.repoName, request.path, target.githubToken, {
    message: payload.message,
    contentBase64: payload.contentBase64,
    ...(sha ? { sha } : {}),
    author: payload.author,
  })) as { content?: { sha?: string } };
  logger.info(
    `save github repo=${target.org}/${target.repoName} path=${request.path} dur=${Date.now() - payload.start}ms`,
  );
  return { ok: true, sha: out.content?.sha ?? null, provider: "github" };
}

async function giteaSha(target: FileTarget, apiPath: string): Promise<string | undefined> {
  try {
    const existing = (await targetGiteaApi(target, apiPath)) as { sha?: string };
    return existing.sha;
  } catch (e) {
    return rethrowUnlessNotFound(e);
  }
}

async function saveGitea(
  target: FileTarget,
  request: Extract<ValidatedSaveRequest, { ok: true }>,
  payload: SavePayload,
): Promise<{ ok: true; sha: string | null; provider: "gitea" }> {
  const apiPath = `${target.repoName}/contents/${request.path}`;
  const sha = await giteaSha(target, apiPath);
  const out = (await targetGiteaApi(target, apiPath, "PUT", {
    message: payload.message,
    content: payload.contentBase64,
    ...(sha ? { sha } : {}),
    author: payload.author,
  })) as { content?: { sha?: string } };
  logger.info(
    `save gitea repo=${target.org}/${target.repoName} path=${request.path} dur=${Date.now() - payload.start}ms`,
  );
  return { ok: true, sha: out.content?.sha ?? null, provider: "gitea" };
}

async function saveTarget(
  target: FileTarget,
  request: Extract<ValidatedSaveRequest, { ok: true }>,
  payload: SavePayload,
): Promise<{ ok: true; sha: string | null; provider: "github" | "gitea" }> {
  if (target.provider === "github") return saveGithub(target, request, payload);
  return saveGitea(target, request, payload);
}

router.post("/save", withFileTarget(async (req, res, _next, target) => {
  const request = validatedSaveRequest(req.body);
  if (!request.ok) {
    sendValidationError(res, request);
    return;
  }

  if (target.brokered && !isBrokeredWritablePath(request.path, target.canvasFile)) {
    sendBrokeredPathError(res);
    return;
  }

  res.json(await saveTarget(target, request, savePayload(req, target, request)));
}, { allowWorkspaceMembers: true }));

export default router;
