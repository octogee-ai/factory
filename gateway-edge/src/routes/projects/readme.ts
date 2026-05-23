import { Router, Request, Response } from "express";
import { db } from "../../lib/db.js";
import { giteaApi } from "../../lib/gitea.js";
import { workspaceGiteaOrg, projectRepoName } from "../../lib/gitea-naming.js";
import { readProject } from "../../lib/firestoreReads.js";
import { logger } from "../../middleware/logging.js";
import { isValidProjectId } from "@shared/types/identity.js";

const router = Router();

const SAFE_CANVAS_PATH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

function isSafeCanvasPath(p: unknown): p is string {
  if (typeof p !== "string") return false;
  if (!SAFE_CANVAS_PATH_RE.test(p)) return false;
  if (p.startsWith("/")) return false;
  if (p.split("/").some((seg) => seg === "..")) return false;
  return true;
}

const WORKSPACE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

router.get("/:wid/:pid/readme", async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  if (!WORKSPACE_SLUG_RE.test(wid) || !isValidProjectId(pid)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const project = await readProject(db.doc(`workspaces/${wid}/projects/${pid}`));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

if (project.visibility !== "public" && project.visibility !== "unlisted") {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const org = workspaceGiteaOrg(wid);
    const repoName = projectRepoName(pid);

const filePath = isSafeCanvasPath(project.canvasFile) ? project.canvasFile : "README.md";

try {
      const file = await giteaApi(org, `${repoName}/contents/${filePath}`);
      const content = Buffer.from(
        (file as { content?: string })?.content ?? "",
        "base64",
      ).toString("utf-8");
      res.json({ content, path: filePath });
    } catch (err) {

if ((err as { status?: number })?.status === 404) {

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

export default router;
