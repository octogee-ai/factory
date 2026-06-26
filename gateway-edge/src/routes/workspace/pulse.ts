import { Router } from "express";
import type { Response } from "express";
import { withFileTarget, type FileTarget } from "../../lib/fileTarget.js";
import { fetchPulseReport } from "../../lib/pulse-ingest.js";

const router = Router();

// Pulse — the project's DX Core 4 weekly brief. Project-scoped + GitHub-only for now
// (the ingestion fetches the GitHub API; Gitea slots in behind the same FileTarget later).
function requireGithubProject(target: FileTarget, res: Response): boolean {
  if (!target.projectSlug) {
    res.status(403).json({ error: "Pulse is project-scoped", code: "PROJECT_ONLY" });
    return false;
  }
  if (target.provider !== "github") {
    res.status(501).json({ error: "Pulse currently supports GitHub-backed projects", code: "GITHUB_ONLY" });
    return false;
  }
  return true;
}

router.get(
  "/pulse",
  withFileTarget(async (_req, res, _next, target) => {
    if (!requireGithubProject(target, res)) return;
    const report = await fetchPulseReport(target, Date.now());
    res.json(report);
  }),
);

export default router;
