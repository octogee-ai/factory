import { Router, Request, Response } from "express";
import { db } from "../../lib/db";
import { giteaApi } from "../../lib/gitea";
import { workspaceGiteaOrg, projectRepoName } from "../../lib/gitea-naming";
import { readProject } from "../../lib/firestoreReads";
import { logger } from "../../middleware/logging";
import { isValidProjectId } from "@shared/types/identity";

const router = Router();

// Conservative shape for a canvas file path — lowercase + upper letters,
// digits, dot, underscore, forward slash (subdirs), hyphen. NO `..`, no
// leading slash, bounded length. canvasFile is owner-writable from the
// client (Firestore rules explicitly don't lock it), so a malicious owner
// of a public project could otherwise set it to `../../other-repo/contents/x`
// and have the anonymous /readme endpoint proxy an admin-token fetch of
// something they wouldn't otherwise reach. Keep this regex strict —
// widening it is a security review.
const SAFE_CANVAS_PATH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

function isSafeCanvasPath(p: unknown): p is string {
  if (typeof p !== "string") return false;
  if (!SAFE_CANVAS_PATH_RE.test(p)) return false;
  if (p.startsWith("/")) return false;
  if (p.split("/").some((seg) => seg === "..")) return false;
  return true;
}

// Workspace slug + project slug shapes — same charset rules the rest of
// the codebase uses. Guards req.params before anything in the route
// interpolates them into Firestore paths or downstream URLs.
const WORKSPACE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

router.get("/:wid/:pid/readme", async (req: Request, res: Response) => {
  const { wid, pid } = req.params;
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
    // Strict visibility gate — public + unlisted render; anything else is a
    // 404 so private-project URL guessing can't confirm existence.
    if (project.visibility !== "public" && project.visibility !== "unlisted") {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const org = workspaceGiteaOrg(wid);
    const repoName = projectRepoName(pid);
    // Gate canvasFile BEFORE it touches the Gitea URL — prevents a malicious
    // owner from steering the admin-token fetch via `../` segments or
    // absolute paths. Fallback to README.md on any invalid shape.
    const filePath = isSafeCanvasPath(project.canvasFile) ? project.canvasFile : "README.md";
    // Admin Gitea token — project repos under the Octogee org are readable
    // to the admin; per-customer tokens aren't required for a public read.
    try {
      const file = await giteaApi(org, `${repoName}/contents/${filePath}`);
      const content = Buffer.from(
        (file as { content?: string })?.content ?? "",
        "base64",
      ).toString("utf-8");
      res.json({ content, path: filePath });
    } catch (err) {
      // `giteaApi` attaches `status` on the thrown Error (added PR 1 §D4).
      // Use it directly — the older message-includes heuristic misfires on
      // unrelated error strings that happen to contain "404".
      if ((err as { status?: number })?.status === 404) {
        // Repo or file missing — 200 + empty so the public page renders
        // without a README rather than erroring. Distinguishes "private
        // project" (404 above) from "public project, no README yet".
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
