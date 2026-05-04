import { Router } from "express";
import * as path from "node:path";
import { withFileTarget } from "../../lib/fileTarget";
import {
  gitDiff,
  gitLog,
  gitStatus,
  resolveCustomerDir,
  type WorkspaceGitError,
} from "../../lib/workspace-git";
import { logger } from "../../middleware/logging";

const router = Router();

/**
 * Phase 6.B (docs/ACTIVITY-STREAM-SPEC.md §10) — workspace working-tree
 * routes. Currently read-only: status / diff / log. Commit / push /
 * branch land in Phase 6.C with their own validation + audit path.
 *
 * Customer dir lookup uses CUSTOMERS_DIR env (defaults to the path the
 * gateway pod uses: `/home/node/.openclaw/customers`). When the volume
 * isn't mounted (workspace-api still standalone — pre-collocation), the
 * resolver returns null and the routes respond 503 with a clear reason.
 */

function customersRoot(): string {
  // Read per-request rather than caching at module load — keeps tests
  // simple (env can be set in beforeAll) and lets operators rotate the
  // mount path without a pod restart.
  return process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers";
}

/**
 * Phase 6.B is workspace-tree-only. `withFileTarget` also authorizes
 * project members on project-scoped requests, but those callers have
 * no claim to read the parent workspace repo's git state. Reject any
 * request that resolved to a project target so a project member can't
 * use ?project= to peek at workspace status / diff / log.
 *
 * Project working-tree views land in Phase 6.C.2 with their own
 * checkout resolver + auth tier.
 */
function rejectIfProjectTarget(
  res: import("express").Response,
  target: { projectSlug: string | null },
): boolean {
  if (target.projectSlug) {
    res.status(400).json({
      error: "Project targets are not supported by this route (Phase 6.B is workspace-only)",
      code: "PROJECT_TARGET_UNSUPPORTED",
    });
    return true;
  }
  return false;
}

/**
 * Per-slug concurrency cap (P1-1 of #825 review). One authenticated
 * owner could otherwise fork-bomb the sidecar by firing N parallel
 * /git/diff requests — each spawns a process up to 5s × 4MB. Cap is
 * intentionally low; the Working Tree pane only ever runs 1 status +
 * 1 diff at a time per workspace.
 */
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
  withFileTarget(async (req, res, _next, target) => {
    if (rejectIfProjectTarget(res, target)) return;
    const start = Date.now();
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveCustomerDir(customersRoot(), target.slug);
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
    logger.info(`git/status slug=${target.slug} dur=${Date.now() - start}ms status=${res.statusCode}`);
  }),
);

router.get(
  "/git/diff",
  withFileTarget(async (req, res, _next, target) => {
    if (rejectIfProjectTarget(res, target)) return;
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
      const dir = await resolveCustomerDir(customersRoot(), target.slug);
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
    logger.info(`git/diff slug=${target.slug} dur=${Date.now() - start}ms status=${res.statusCode}`);
  }),
);

router.get(
  "/git/log",
  withFileTarget(async (req, res, _next, target) => {
    if (rejectIfProjectTarget(res, target)) return;
    const start = Date.now();
    const limit = req.query.limit ? Number.parseInt(String(req.query.limit), 10) : undefined;
    const branch = typeof req.query.branch === "string" ? req.query.branch : undefined;
    if (branch && !isSafeRefName(branch)) {
      res.status(400).json({ error: "Invalid branch", code: "BAD_BRANCH" });
      return;
    }
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveCustomerDir(customersRoot(), target.slug);
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
    logger.info(`git/log slug=${target.slug} dur=${Date.now() - start}ms status=${res.statusCode}`);
  }),
);

function respondCustomerDirMissing(res: import("express").Response, slug: string): void {
  // 503 (not 404) because the workspace exists in Firestore — the only
  // reason the dir is missing is operational. Operator-facing detail
  // (volume mount status, sidecar collocation, etc.) goes server-side
  // via the request-completion log line, not in the user response.
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

/**
 * Allow only paths that don't traverse out of the workspace dir. Reject
 * leading slash, parent-dir segments, and null bytes. Same posture as
 * `lib/path-validation.ts` but tighter for shell-out context.
 */
function isSafeRelativePath(p: string): boolean {
  if (!p || p.length > 1024) return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\0")) return false;
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "..") return false;
  }
  // Block paths that resolve outside the cwd via path.resolve sanity check.
  const resolved = path.resolve("/cwd", p);
  if (!resolved.startsWith("/cwd/") && resolved !== "/cwd") return false;
  return true;
}

/**
 * Allow ref / branch names that pass git's basic validity rules — no
 * spaces, no shell metacharacters, no leading dash (which would be
 * interpreted as a flag). Allowlist is intentionally tight; users will
 * pass branch names like `main`, `feat/foo`, `v1.2.3`, not arbitrary
 * git revision specs.
 */
function isSafeRefName(ref: string): boolean {
  if (!ref || ref.length > 250) return false;
  if (ref.startsWith("-")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(ref);
}

export default router;
