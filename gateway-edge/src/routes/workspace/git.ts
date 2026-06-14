import { Router } from "express";
import * as path from "node:path";
import { withGiteaTarget, type FileTarget } from "../../lib/fileTarget.js";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCommitDiff,
  gitDiff,
  gitLog,
  gitPush,
  gitStatus,
  resolveCustomerDir,
  resolveProjectDir,
  type WorkspaceGitError,
} from "../../lib/workspace-git.js";
import { resolveCommitAuthor } from "./helpers.js";
import { logger } from "../../middleware/logging.js";

const router = Router();

function customersRoot(): string {

return process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers";
}

async function resolveTargetDir(
  root: string,
  target: FileTarget,
): Promise<string | null> {
  if (target.projectSlug) {
    return resolveProjectDir(root, target.slug, target.projectSlug);
  }
  return resolveCustomerDir(root, target.slug);
}

function ensureWriteAuth(
  req: import("express").Request,
  res: import("express").Response,
  target: FileTarget,
): boolean {
  if (target.projectSlug) return true;
  if (req.workspaceSlug !== target.slug) {
    res.status(403).json({
      error: "Workspace owner only",
      code: "OWNER_ONLY",
    });
    return false;
  }
  return true;
}

const MAX_CONCURRENT_PER_SLUG = 4;
const concurrencyBySlug = new Map<string, number>();

function acquireSlot(slug: string): boolean {
  const inflight = concurrencyBySlug.get(slug) ?? 0;
  if (inflight >= MAX_CONCURRENT_PER_SLUG) return false;
  concurrencyBySlug.set(slug, inflight + 1);
  return true;
}

function releaseSlot(slug: string): void {
  const inflight = concurrencyBySlug.get(slug) ?? 0;
  if (inflight <= 1) concurrencyBySlug.delete(slug);
  else concurrencyBySlug.set(slug, inflight - 1);
}

async function withSlugLimit<T>(
  slug: string,
  res: import("express").Response,
  body: () => Promise<T>,
): Promise<T | undefined> {
  if (!acquireSlot(slug)) {
    res.status(429).json({
      error: "Too many concurrent git operations for this workspace",
      code: "CONCURRENCY_LIMIT",
      limit: MAX_CONCURRENT_PER_SLUG,
    });
    return undefined;
  }
  try {
    return await body();
  } finally {
    releaseSlot(slug);
  }
}

router.get(
  "/git/status",
  withGiteaTarget(async (req, res, _next, target) => {
    const start = Date.now();
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(customersRoot(), target);
      if (!dir) {
        respondCustomerDirMissing(res, target.slug);
        return;
      }
      const r = await gitStatus(dir);
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.json({ entries: r.entries });
    });
    logger.info(`git/status slug=${target.slug} project=${target.projectSlug ?? "-"} dur=${Date.now() - start}ms status=${res.statusCode}`);
  }),
);

router.get(
  "/git/diff",
  withGiteaTarget(async (req, res, _next, target) => {
    const start = Date.now();
    const filePath = typeof req.query.path === "string" ? req.query.path : undefined;
    const ref = typeof req.query.ref === "string" ? req.query.ref : undefined;
    if (filePath && !isSafeRelativePath(filePath)) {
      res.status(400).json({ error: "Invalid path", code: "BAD_PATH" });
      return;
    }
    if (ref && !isSafeRefName(ref)) {
      res.status(400).json({ error: "Invalid ref", code: "BAD_REF" });
      return;
    }
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(customersRoot(), target);
      if (!dir) {
        respondCustomerDirMissing(res, target.slug);
        return;
      }
      const r = await gitDiff(dir, { path: filePath, ref });
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.type("text/plain; charset=utf-8").send(r.diff);
    });
    logger.info(`git/diff slug=${target.slug} project=${target.projectSlug ?? "-"} dur=${Date.now() - start}ms status=${res.statusCode}`);
  }),
);

router.get(
  "/git/commit-diff",
  withGiteaTarget(async (req, res, _next, target) => {
    const start = Date.now();
    const commit = typeof req.query.commit === "string" ? req.query.commit : undefined;
    if (!commit || !isSafeRefName(commit)) {
      res.status(400).json({ error: "Invalid commit ref", code: "BAD_REF" });
      return;
    }
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(customersRoot(), target);
      if (!dir) {
        respondCustomerDirMissing(res, target.slug);
        return;
      }
      const r = await gitCommitDiff(dir, commit);
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.type("text/plain; charset=utf-8").send(r.diff);
    });
    logger.info(`git/commit-diff slug=${target.slug} project=${target.projectSlug ?? "-"} dur=${Date.now() - start}ms status=${res.statusCode}`);
  }),
);

router.get(
  "/git/log",
  withGiteaTarget(async (req, res, _next, target) => {
    const start = Date.now();
    const limit = req.query.limit ? Number.parseInt(String(req.query.limit), 10) : undefined;
    const branch = typeof req.query.branch === "string" ? req.query.branch : undefined;
    if (branch && !isSafeRefName(branch)) {
      res.status(400).json({ error: "Invalid branch", code: "BAD_BRANCH" });
      return;
    }
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(customersRoot(), target);
      if (!dir) {
        respondCustomerDirMissing(res, target.slug);
        return;
      }
      const r = await gitLog(dir, { limit, branch });
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.json({ entries: r.entries });
    });
    logger.info(`git/log slug=${target.slug} project=${target.projectSlug ?? "-"} dur=${Date.now() - start}ms status=${res.statusCode}`);
  }),
);

router.get(
  "/git/branches",
  withGiteaTarget(async (req, res, _next, target) => {
    const start = Date.now();
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(customersRoot(), target);
      if (!dir) {
        respondCustomerDirMissing(res, target.slug);
        return;
      }
      const r = await gitBranches(dir);
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.json({ entries: r.entries });
    });
    logger.info(`git/branches slug=${target.slug} project=${target.projectSlug ?? "-"} dur=${Date.now() - start}ms status=${res.statusCode}`);
  }),
);

function respondCustomerDirMissing(res: import("express").Response, slug: string): void {

logger.warn(`git: working tree not accessible for slug=${slug} — verify sidecar volume mount`);
  res.status(503).json({
    error: "Working tree temporarily unavailable; retry in a few seconds.",
    code: "CUSTOMER_DIR_MISSING",
  });
}

function respondGitError(res: import("express").Response, err: WorkspaceGitError): void {
  switch (err.code) {
    case "NOT_A_REPO":
      res.status(503).json({ error: "Not a git repository", code: err.code });
      return;
    case "TIMEOUT":
      res.status(504).json({ error: "git timed out", code: err.code, durationMs: err.durationMs });
      return;
    case "OUTPUT_TOO_LARGE":
      res.status(413).json({ error: "git output exceeded cap", code: err.code, cap: err.cap });
      return;
    case "GIT_FAILED":
      logger.warn("workspace-git: git command failed", { status: err.status, stderr: err.stderr });
      res.status(500).json({ error: "git command failed", code: err.code, status: err.status });
      return;
    case "INTERNAL":
      logger.error("workspace-git: internal error", { message: err.message });
      res.status(500).json({ error: "internal error", code: err.code });
      return;
    default:
      res.status(500).json({ error: "git error", code: "UNKNOWN" });
  }
}

function isSafeRelativePath(p: string): boolean {
  if (!p || p.length > 1024) return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\0")) return false;
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "..") return false;
  }
  const resolved = path.resolve("/cwd", p);
  if (!resolved.startsWith("/cwd/") && resolved !== "/cwd") return false;
  return true;
}

function isSafeRefName(ref: string): boolean {
  if (!ref || ref.length > 250) return false;
  if (ref.startsWith("-")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(ref);
}

router.post(
  "/git/commit",
  withGiteaTarget(async (req, res, _next, target) => {
    if (!ensureWriteAuth(req, res, target)) return;
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      res.status(400).json({ error: "Missing or empty `message`", code: "BAD_MESSAGE" });
      return;
    }
    if (message.length > 5_000) {
      res.status(400).json({ error: "Commit message too long (5000 char max)", code: "MESSAGE_TOO_LONG" });
      return;
    }
    const start = Date.now();
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(customersRoot(), target);
      if (!dir) {
        respondCustomerDirMissing(res, target.slug);
        return;
      }
      const author = resolveCommitAuthor(req.user, target.slug);
      const r = await gitCommit(dir, { message, author });
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.json({ sha: r.result.sha, empty: r.result.empty });
    });
    logger.info(`git/commit slug=${target.slug} project=${target.projectSlug ?? "-"} dur=${Date.now() - start}ms status=${res.statusCode}`);
  }),
);

router.post(
  "/git/push",
  withGiteaTarget(async (req, res, _next, target) => {
    if (!ensureWriteAuth(req, res, target)) return;
    const branch = typeof req.body?.branch === "string" ? req.body.branch : undefined;
    if (branch && !isSafeRefName(branch)) {
      res.status(400).json({ error: "Invalid branch", code: "BAD_BRANCH" });
      return;
    }
    const start = Date.now();
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(customersRoot(), target);
      if (!dir) {
        respondCustomerDirMissing(res, target.slug);
        return;
      }
      const r = await gitPush(dir, { branch });
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.json({ ok: true });
    });
    logger.info(`git/push slug=${target.slug} project=${target.projectSlug ?? "-"} dur=${Date.now() - start}ms status=${res.statusCode}`);
  }),
);

router.post(
  "/git/branch/checkout",
  withGiteaTarget(async (req, res, _next, target) => {
    if (!ensureWriteAuth(req, res, target)) return;
    const branch = typeof req.body?.branch === "string" ? req.body.branch : "";
    const create = req.body?.create === true;
    if (!branch || !isSafeRefName(branch)) {
      res.status(400).json({ error: "Invalid branch", code: "BAD_BRANCH" });
      return;
    }
    const start = Date.now();
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(customersRoot(), target);
      if (!dir) {
        respondCustomerDirMissing(res, target.slug);
        return;
      }
      const r = await gitCheckout(dir, { branch, create });
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.json({ ok: true, branch });
    });
    logger.info(`git/branch/checkout slug=${target.slug} project=${target.projectSlug ?? "-"} branch=${branch} create=${create} dur=${Date.now() - start}ms status=${res.statusCode}`);
  }),
);

export default router;
