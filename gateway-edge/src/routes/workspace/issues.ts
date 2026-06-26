import { Router } from "express";
import type { Response } from "express";
import { withFileTarget, type FileTarget } from "../../lib/fileTarget.js";
import { createIssue, listIssues, listLabels, moveIssue, NotAnIssueError } from "../../lib/issues.js";
import { isValidColumn } from "../../lib/issues-write.js";

const router = Router();
const MAX_TITLE = 250;

// The Board is project-scoped — issues live in the project repo. Reject workspace-scope
// targets so a workspace canvas can't read or mutate workspace-repo issues. Inputs are
// re-validated here too: the privileged provider call never trusts the client's
// title/column/number.
function requireProject(target: FileTarget, res: Response): boolean {
  if (!target.projectSlug) {
    res.status(403).json({ error: "The Board is project-scoped", code: "PROJECT_ONLY" });
    return false;
  }
  return true;
}

router.get(
  "/issues",
  withFileTarget(async (_req, res, _next, target) => {
    if (!requireProject(target, res)) return;
    const [issues, labels] = await Promise.all([listIssues(target), listLabels(target)]);
    res.json({ issues, labels });
  }),
);

router.post(
  "/issues",
  withFileTarget(async (req, res, _next, target) => {
    if (!requireProject(target, res)) return;
    const title = String(req.body?.title ?? "").trim();
    const body = String(req.body?.body ?? "");
    const status = String(req.body?.status ?? "backlog");
    if (!title) {
      res.status(400).json({ error: "Missing title" });
      return;
    }
    if (title.length > MAX_TITLE) {
      res.status(400).json({ error: "Title too long" });
      return;
    }
    if (!isValidColumn(status)) {
      res.status(400).json({ error: "Invalid column" });
      return;
    }
    const issue = await createIssue(target, { title, body, status });
    res.status(201).json({ issue });
  }),
);

router.patch(
  "/issues/:number/move",
  withFileTarget(async (req, res, _next, target) => {
    if (!requireProject(target, res)) return;
    const num = Number(req.params.number);
    const status = String(req.body?.status ?? "");
    if (!Number.isInteger(num) || num <= 0) {
      res.status(400).json({ error: "Invalid issue number" });
      return;
    }
    if (!isValidColumn(status)) {
      res.status(400).json({ error: "Invalid column" });
      return;
    }
    try {
      const issue = await moveIssue(target, num, status);
      res.json({ issue });
    } catch (e) {
      // A PR shares the issue-number space on GitHub; never let a move close/relabel one.
      if (e instanceof NotAnIssueError) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      throw e;
    }
  }),
);

export default router;
