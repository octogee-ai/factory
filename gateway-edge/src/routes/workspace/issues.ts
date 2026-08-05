import { Router } from "express";
import type { Request, Response } from "express";
import { withFileTarget, type FileTarget } from "../../lib/fileTarget.js";
import {
  addComment,
  assertIssueExists,
  createIssue,
  getIssueDetail,
  listIssues,
  listLabels,
  moveIssue,
  updateIssue,
  IssueNotFoundError,
  NotAnIssueError,
} from "../../lib/issues.js";
import { isValidColumn, isValidLabelName } from "../../lib/issues-write.js";
import {
  deleteIssueAsset,
  IssueAssetTooLargeError,
  listIssueAssets,
  MAX_ISSUE_ASSET_BYTES,
  storeIssueAsset,
} from "../../lib/issue-assets.js";
import { parseMultipart, UploadTooLargeError } from "./upload.js";

const router = Router();
const MAX_TITLE = 250;
const MAX_BODY = 65_536;
const MAX_COMMENT = 65_536;
const MAX_LABELS = 20;

function parseIssueNumber(req: Request, res: Response): number | null {
  const num = Number(req.params.number);
  if (!Number.isInteger(num) || num <= 0) {
    res.status(400).json({ error: "Invalid issue number" });
    return null;
  }
  return num;
}

function parseLabels(value: unknown, res: Response): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_LABELS || value.some((l) => typeof l !== "string")) {
    res.status(400).json({ error: "Invalid labels" });
    return null;
  }
  const labels = (value as string[]).map((l) => l.trim()).filter((l) => l.length > 0);
  if (labels.some((l) => !isValidLabelName(l))) {
    res.status(400).json({ error: "Invalid labels" });
    return null;
  }
  return labels;
}

// PRs share the issue-number space and provider 404s mean the number never
// existed — both are "not found" to the Board.
function respondNotAnIssue(res: Response, e: unknown): boolean {
  if (e instanceof NotAnIssueError || e instanceof IssueNotFoundError) {
    res.status(404).json({ error: "Issue not found" });
    return true;
  }
  return false;
}

// Reject non-string bodies outright — String() coercion would write garbage
// like "[object Object]" into the provider.
function parseString(value: unknown, res: Response, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    res.status(400).json({ error: `Invalid ${field}` });
    return null;
  }
  return value;
}

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
    const rawTitle = parseString(req.body?.title, res, "title");
    if (rawTitle === null) return;
    const rawBody = parseString(req.body?.body, res, "body");
    if (rawBody === null) return;
    const rawStatus = parseString(req.body?.status, res, "status");
    if (rawStatus === null) return;
    const title = (rawTitle ?? "").trim();
    const body = rawBody ?? "";
    const status = rawStatus ?? "backlog";
    if (!title) {
      res.status(400).json({ error: "Missing title" });
      return;
    }
    if (title.length > MAX_TITLE) {
      res.status(400).json({ error: "Title too long" });
      return;
    }
    if (body.length > MAX_BODY) {
      res.status(400).json({ error: "Body too long" });
      return;
    }
    if (!isValidColumn(status)) {
      res.status(400).json({ error: "Invalid column" });
      return;
    }
    const labels = parseLabels(req.body?.labels, res);
    if (labels === null) return;
    const issue = await createIssue(target, { title, body, status, ...(labels ? { labels } : {}) });
    res.status(201).json({ issue });
  }, { access: "write" }),
);

router.get(
  "/issues/:number",
  withFileTarget(async (req, res, _next, target) => {
    if (!requireProject(target, res)) return;
    const num = parseIssueNumber(req, res);
    if (num === null) return;
    try {
      const [detail, attachments] = await Promise.all([
        getIssueDetail(target, num),
        listIssueAssets(target, num),
      ]);
      res.json({ ...detail, attachments });
    } catch (e) {
      if (respondNotAnIssue(res, e)) return;
      throw e;
    }
  }),
);

router.patch(
  "/issues/:number",
  withFileTarget(async (req, res, _next, target) => {
    if (!requireProject(target, res)) return;
    const num = parseIssueNumber(req, res);
    if (num === null) return;
    const rawTitle = parseString(req.body?.title, res, "title");
    if (rawTitle === null) return;
    const rawBody = parseString(req.body?.body, res, "body");
    if (rawBody === null) return;
    const title = rawTitle === undefined ? undefined : rawTitle.trim();
    const body = rawBody;
    if (title !== undefined && (title.length === 0 || title.length > MAX_TITLE)) {
      res.status(400).json({ error: title.length === 0 ? "Missing title" : "Title too long" });
      return;
    }
    if (body !== undefined && body.length > MAX_BODY) {
      res.status(400).json({ error: "Body too long" });
      return;
    }
    const labels = parseLabels(req.body?.labels, res);
    if (labels === null) return;
    if (title === undefined && body === undefined && labels === undefined) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    try {
      const issue = await updateIssue(target, num, { title, body, labels });
      res.json({ issue });
    } catch (e) {
      if (respondNotAnIssue(res, e)) return;
      throw e;
    }
  }, { access: "write" }),
);

router.post(
  "/issues/:number/comments",
  withFileTarget(async (req, res, _next, target) => {
    if (!requireProject(target, res)) return;
    const num = parseIssueNumber(req, res);
    if (num === null) return;
    const rawBody = parseString(req.body?.body, res, "comment body");
    if (rawBody === null) return;
    const body = (rawBody ?? "").trim();
    if (!body) {
      res.status(400).json({ error: "Missing comment body" });
      return;
    }
    if (body.length > MAX_COMMENT) {
      res.status(400).json({ error: "Comment too long" });
      return;
    }
    try {
      const comment = await addComment(target, num, body);
      res.status(201).json({ comment });
    } catch (e) {
      if (respondNotAnIssue(res, e)) return;
      throw e;
    }
  }, { access: "write" }),
);

router.post(
  "/issues/:number/attachments",
  withFileTarget(async (req, res, _next, target) => {
    if (!requireProject(target, res)) return;
    const num = parseIssueNumber(req, res);
    if (num === null) return;
    let upload: Awaited<ReturnType<typeof parseMultipart>>;
    try {
      upload = await parseMultipart(req, MAX_ISSUE_ASSET_BYTES, { requireSlugAndPath: false });
    } catch (e) {
      if (e instanceof UploadTooLargeError) {
        res.status(413).json({ error: "Attachment too large", maxBytes: MAX_ISSUE_ASSET_BYTES });
        return;
      }
      res.status(400).json({ error: e instanceof Error ? e.message : "Invalid upload" });
      return;
    }
    try {
      // Assets must hang off a real issue — never a PR or a number that
      // doesn't exist.
      await assertIssueExists(target, num);
      const attachment = await storeIssueAsset(target, num, {
        name: upload.filename,
        content: upload.fileBuffer,
        contentType: upload.mimeType,
      });
      res.status(201).json({ attachment });
    } catch (e) {
      if (respondNotAnIssue(res, e)) return;
      if (e instanceof IssueAssetTooLargeError) {
        res.status(413).json({ error: "Attachment too large", maxBytes: MAX_ISSUE_ASSET_BYTES });
        return;
      }
      throw e;
    }
  }, { access: "write" }),
);

router.delete(
  "/issues/:number/attachments/:assetId",
  withFileTarget(async (req, res, _next, target) => {
    if (!requireProject(target, res)) return;
    const num = parseIssueNumber(req, res);
    if (num === null) return;
    try {
      await assertIssueExists(target, num);
    } catch (e) {
      if (respondNotAnIssue(res, e)) return;
      throw e;
    }
    const removed = await deleteIssueAsset(target, num, String(req.params.assetId));
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    res.json({ removed: true });
  }, { access: "write" }),
);

router.patch(
  "/issues/:number/move",
  withFileTarget(async (req, res, _next, target) => {
    if (!requireProject(target, res)) return;
    const num = Number(req.params.number);
    if (!Number.isInteger(num) || num <= 0) {
      res.status(400).json({ error: "Invalid issue number" });
      return;
    }
    const rawStatus = parseString(req.body?.status, res, "status");
    if (rawStatus === null) return;
    const status = rawStatus ?? "";
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
  }, { access: "write" }),
);

export default router;
