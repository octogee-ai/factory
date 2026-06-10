import { Router } from "express";
import { requireAdmin } from "../../middleware/auth.js";
import { githubListRepos } from "../../lib/github.js";

const router = Router();

router.get("/github/repos", requireAdmin, async (_req, res, next) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    res.status(422).json({ error: "GitHub not connected", reason: "github_token_unset" });
    return;
  }
  try {
    const { repos, truncated } = await githubListRepos(token);
    res.json({ repos, truncated });
  } catch (e) {
    next(e);
  }
});

export default router;
