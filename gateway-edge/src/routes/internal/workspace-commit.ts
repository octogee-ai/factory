import { Router, type Request, type Response } from "express";
import {
  resolveCustomerDir,
  commitAndPushWorkspace,
  isSafeSlug,
} from "../../lib/workspace-git.js";
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
router.post("/commit", async (req: Request, res: Response) => {
  const slug = typeof req.body?.slug === "string" ? req.body.slug : "";
  if (!isSafeSlug(slug)) {
    res.status(400).json({ error: "Invalid slug", code: "BAD_SLUG" });
    return;
  }
  const raw = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (raw.length > MAX_MESSAGE_LEN) {
    res.status(400).json({ error: "Commit message too long", code: "MESSAGE_TOO_LONG" });
    return;
  }
  const message = raw || DEFAULT_MESSAGE;

  const start = Date.now();
  const dir = await resolveCustomerDir(customersRoot(), slug);
  if (!dir) {
    logger.warn(`internal/workspace/commit: working tree not accessible slug=${slug}`);
    res.status(503).json({
      error: "Working tree temporarily unavailable; retry shortly.",
      code: "CUSTOMER_DIR_MISSING",
    });
    return;
  }

  const author = resolveCommitAuthor(undefined, slug);
  const r = await commitAndPushWorkspace(dir, { message, author });
  if (!r.ok) {
    logger.warn(`internal/workspace/commit: git error slug=${slug} code=${r.error.code}`);
    res.status(500).json({ error: "git command failed", code: r.error.code });
    return;
  }
  if (r.result.pushError) {
    logger.warn(`internal/workspace/commit: committed but push failed slug=${slug}: ${r.result.pushError}`);
  }
  logger.info(
    `internal/workspace/commit slug=${slug} committed=${r.result.committed} pushed=${r.result.pushed} nothing=${r.result.nothingToCommit} dur=${Date.now() - start}ms`,
  );
  res.json({
    committed: r.result.committed,
    pushed: r.result.pushed,
    nothingToCommit: r.result.nothingToCommit,
  });
});

export default router;
