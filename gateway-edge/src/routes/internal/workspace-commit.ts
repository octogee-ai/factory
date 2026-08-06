import { Router, type Request, type Response } from "express";
import {
  resolveCustomerDir,
  resolveProjectDir,
  commitAndPushWorkspace,
  isSafeSlug,
} from "../../lib/workspace-git.js";
import { isValidProjectId } from "@octogee/shared/types/identity";
import { resolveCommitAuthor } from "../workspace/helpers.js";
import { logger } from "../../middleware/logging.js";

const router = Router();

const DEFAULT_MESSAGE = "agent: workspace commit";
const MAX_MESSAGE_LEN = 5_000;

function customersRoot(): string {
  return process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers";
}

/**
 * Internal (no-auth, in-pod) commit+push for the `workspace_commit` agent tool.
 * Mounted under /internal/* — same trust boundary as /internal/agents — so an
 * exec-off coach can checkpoint its own workspace without a shell. The slug is
 * supplied by the tool from the agent's identity; the tool is the boundary that
 * scopes a coach to its own workspace (it never lets the agent name another).
 */
type CommitRequest = { slug: string; project: string | null; message: string };
type CommitRequestError = { status: number; error: string; code: string };

function parseCommitRequest(
  body: Record<string, unknown> | undefined,
): CommitRequest | CommitRequestError {
  const slug = typeof body?.slug === "string" ? body.slug : "";
  if (!isSafeSlug(slug)) return { status: 400, error: "Invalid slug", code: "BAD_SLUG" };
  const project = typeof body?.project === "string" ? body.project : null;
  if (project !== null && !isValidProjectId(project)) {
    return { status: 400, error: "Invalid project", code: "BAD_PROJECT" };
  }
  const raw = typeof body?.message === "string" ? body.message.trim() : "";
  if (raw.length > MAX_MESSAGE_LEN) {
    return { status: 400, error: "Commit message too long", code: "MESSAGE_TOO_LONG" };
  }
  return { slug, project, message: raw || DEFAULT_MESSAGE };
}

router.post("/commit", async (req: Request, res: Response) => {
  const parsed = parseCommitRequest(req.body as Record<string, unknown> | undefined);
  if ("code" in parsed) {
    res.status(parsed.status).json({ error: parsed.error, code: parsed.code });
    return;
  }
  const { slug, project, message } = parsed;

  const start = Date.now();
  const customerDir = await resolveCustomerDir(customersRoot(), slug);
  if (!customerDir) {
    logger.warn(`internal/workspace/commit: working tree not accessible slug=${slug}`);
    res.status(503).json({
      error: "Working tree temporarily unavailable; retry shortly.",
      code: "CUSTOMER_DIR_MISSING",
    });
    return;
  }
  // Project agents commit their project clone ONLY; the lane comes from the
  // tool's identity-derived request, and a missing clone must fail loudly
  // rather than fall back to the workspace repo.
  let dir = customerDir;
  if (project) {
    const projectDir = await resolveProjectDir(customersRoot(), slug, project);
    if (!projectDir) {
      logger.warn(`internal/workspace/commit: project clone missing slug=${slug} project=${project}`);
      res.status(503).json({
        error: "Project working tree temporarily unavailable; retry shortly.",
        code: "PROJECT_DIR_MISSING",
      });
      return;
    }
    dir = projectDir;
  }

  const author = resolveCommitAuthor(undefined, slug);
  // Workspace-lane commits must never sweep the nested project clones — each
  // project repo has its own commit path (octogee_project_commit). The
  // exclusion is enforced here, not just .gitignore, so workspaces seeded
  // before projects/ was ignored are covered too.
  const r = await commitAndPushWorkspace(dir, {
    message,
    author,
    ...(project ? {} : { excludePathspecs: ["projects"] }),
  });
  if (!r.ok) {
    logger.warn(`internal/workspace/commit: git error slug=${slug} code=${r.error.code}`);
    if (r.error.code === "WORKSPACE_BUSY") {
      res.status(409).json({ error: "Workspace is busy; retry shortly.", code: r.error.code });
      return;
    }
    res.status(500).json({ error: "git command failed", code: r.error.code });
    return;
  }
  if (r.result.pushError) {
    logger.warn(`internal/workspace/commit: committed but push failed slug=${slug}: ${r.result.pushError}`);
  }
  const laneSuffix = project ? ` project=${project}` : "";
  logger.info(
    `internal/workspace/commit slug=${slug}${laneSuffix} committed=${r.result.committed} pushed=${r.result.pushed} nothing=${r.result.nothingToCommit} dur=${Date.now() - start}ms`,
  );
  res.json({
    committed: r.result.committed,
    pushed: r.result.pushed,
    nothingToCommit: r.result.nothingToCommit,
  });
});

export default router;
