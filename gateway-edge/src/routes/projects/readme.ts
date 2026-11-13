import { clientRequestLimit, authenticatedRequestLimit } from "../../middleware/authenticated-request-limit.js";
import { Router, Request, Response } from "express";
import type { Project } from "@octogee/shared/types/index";
import { FieldValue } from "../../lib/db.js";
import { giteaApi } from "../../lib/gitea.js";
import { githubContentsApi } from "../../lib/github.js";
import { workspaceGiteaOrg, projectRepoName } from "@octogee/core/gitea-naming";
import { readConnectorAccessToken } from "../../lib/connector-tokens.js";
import { readProject } from "../../lib/firestoreReads.js";
import { withProject } from "../../lib/withProject.js";
import { requireAuth } from "../../middleware/auth.js";
import { logger } from "../../middleware/logging.js";
import { isSettableCanvasFile, resolveCanvasFile } from "../../lib/canvas-file.js";
import { isValidProjectId } from "@octogee/shared/types/identity";

const router = Router();

const WORKSPACE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GITHUB_NOT_FOUND_MESSAGE = "GitHub API 404";

function canvasFileMissing(err: unknown): boolean {
  if ((err as { status?: number })?.status === 404) return true;
  return err instanceof Error && err.message === GITHUB_NOT_FOUND_MESSAGE;
}

async function readPublicCanvasFile(
  project: Project,
  wid: string,
  pid: string,
  canvasPath: string,
): Promise<string> {
  const github = project.repoSource?.provider === "github" ? project.repoSource : null;
  const file = github
    ? await githubContentsApi(
        github.owner,
        github.repo,
        canvasPath,
        await publicCanvasGithubToken(project.ownerUid, wid, pid, canvasPath),
      )
    : await giteaApi(workspaceGiteaOrg(wid), `${projectRepoName(pid)}/contents/${canvasPath}`);
  return Buffer.from((file as { content?: string })?.content ?? "", "base64").toString("utf-8");
}

async function publicCanvasGithubToken(
  ownerUid: string,
  wid: string,
  pid: string,
  canvasPath: string,
): Promise<string> {
  const token = await readConnectorAccessToken(ownerUid, "github", {
    kind: "public-canvas",
    workspaceSlug: wid,
    projectSlug: pid,
    canvasPath,
  });
  if (!token) {
    throw new Error(`owner GitHub connector unavailable for ${wid}/${pid}`);
  }
  return token;
}

router.get("/:wid/:pid/readme", clientRequestLimit(1200), async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  if (!WORKSPACE_SLUG_RE.test(wid) || !isValidProjectId(pid)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const project = await readProject(wid, pid);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.visibility !== "public" && project.visibility !== "unlisted") {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const filePath = resolveCanvasFile(project.canvasFile);

    try {
      res.json({ content: await readPublicCanvasFile(project, wid, pid, filePath), path: filePath });
    } catch (err) {
      if (canvasFileMissing(err)) {
        res.json({ content: "", path: filePath });
        return;
      }
      throw err;
    }
  } catch (err) {
    logger.error(`[projects] Public README fetch failed for ${wid}/${pid}:`, { err });
    res.status(500).json({ error: "Failed to load project readme" });
  }
});

router.put("/:wid/:pid/canvas-file", requireAuth, authenticatedRequestLimit(60), async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  const canvasFile = (req.body as { canvasFile?: unknown } | undefined)?.canvasFile;

  await withProject(req, res, wid, pid, {
    ownerOnly: true,
    requireActive: true,
    ownerErrorMessage: "Only the project owner can set the canvas file",
    logTag: "[canvas-file] update failed for",
    errorMessage: "Failed to update canvas file",
  }, async ({ projectRef }) => {
    if (!isSettableCanvasFile(canvasFile)) {
      res.status(400).json({
        error: "canvasFile must be a repo-relative markdown path",
      });
      return;
    }

    await projectRef.update({ canvasFile, updatedAt: FieldValue.serverTimestamp() });
    logger.info(`[canvas-file] ${wid}/${pid} → ${canvasFile}`);
    res.json({ ok: true, canvasFile });
  });
});

export default router;
