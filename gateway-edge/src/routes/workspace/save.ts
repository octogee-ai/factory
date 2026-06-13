import { Router } from "express";
import { withFileTarget } from "../../lib/fileTarget.js";
import { githubContentsApi, githubContentsPut } from "../../lib/github.js";
import {
  isBrokeredWritablePath,
  isTextFile,
  requireGiteaToken,
  resolveCommitAuthor,
  targetGiteaApi,
  validateWorkspacePath,
} from "./helpers.js";
import { logger } from "../../middleware/logging.js";

const router = Router();

const MAX_SAVE_BYTES = 1024 * 1024;

function commitMessage(path: string, authorName: string): string {
  const kind = path.startsWith("notes/") ? "notes" : "canvas";
  return `${kind}: edit ${path} — ${authorName} via Octogee Canvas`;
}

function rethrowUnlessNotFound(e: unknown): undefined {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("404")) return undefined;
  throw e;
}

router.post("/save", withFileTarget(async (req, res, _next, target) => {
  const path = typeof req.body?.path === "string" ? req.body.path : "";
  const content = typeof req.body?.content === "string" ? req.body.content : null;
  if (!path) { res.status(400).json({ error: "Missing path" }); return; }
  if (content === null) { res.status(400).json({ error: "Missing content" }); return; }

  const pathError = validateWorkspacePath(path);
  if (pathError) { res.status(400).json({ error: pathError }); return; }
  if (!isTextFile(path)) {
    res.status(400).json({ error: "Only text files can be saved", code: "NOT_TEXT" });
    return;
  }
  if (Buffer.byteLength(content, "utf8") > MAX_SAVE_BYTES) {
    res.status(413).json({ error: "Content too large", code: "TOO_LARGE" });
    return;
  }

  const author = resolveCommitAuthor(req.user, target.slug);
  const message = commitMessage(path, author.name);
  const contentBase64 = Buffer.from(content, "utf8").toString("base64");
  const start = Date.now();

  if (target.provider === "github") {
    if (!isBrokeredWritablePath(path, target.canvasFile)) {
      res.status(403).json({
        error: "Only notes and the canvas home file are writable with a brokered token",
        code: "PATH_NOT_WRITABLE",
      });
      return;
    }
    let sha: string | undefined;
    try {
      const existing = (await githubContentsApi(
        target.org, target.repoName, path, target.githubToken,
      )) as { sha?: string };
      sha = existing.sha;
    } catch (e) {
      rethrowUnlessNotFound(e);
    }
    const out = (await githubContentsPut(target.org, target.repoName, path, target.githubToken, {
      message,
      contentBase64,
      ...(sha ? { sha } : {}),
      author,
    })) as { content?: { sha?: string } };
    logger.info(
      `save github repo=${target.org}/${target.repoName} path=${path} dur=${Date.now() - start}ms`,
    );
    res.json({ ok: true, sha: out.content?.sha ?? null, provider: "github" });
    return;
  }

  if (target.giteaToken && !isBrokeredWritablePath(path, target.canvasFile)) {
    res.status(403).json({
      error: "Only notes and the canvas home file are writable with a brokered token",
      code: "PATH_NOT_WRITABLE",
    });
    return;
  }
  if (!target.giteaToken && !requireGiteaToken(req, res)) return;
  const apiPath = `${target.repoName}/contents/${path}`;
  let sha: string | undefined;
  try {
    const existing = (await targetGiteaApi(req, target, apiPath)) as { sha?: string };
    sha = existing.sha;
  } catch (e) {
    rethrowUnlessNotFound(e);
  }
  const out = (await targetGiteaApi(req, target, apiPath, "PUT", {
    message,
    content: contentBase64,
    ...(sha ? { sha } : {}),
    author,
  })) as { content?: { sha?: string } };
  logger.info(
    `save gitea repo=${target.org}/${target.repoName} path=${path} dur=${Date.now() - start}ms`,
  );
  res.json({ ok: true, sha: out.content?.sha ?? null, provider: "gitea" });
}, { allowWorkspaceMembers: true }));

export default router;
