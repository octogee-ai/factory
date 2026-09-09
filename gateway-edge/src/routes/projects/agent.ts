import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { logger } from "../../middleware/logging.js";
import { provisionProjectAgent } from "../../lib/project-agent-service.js";

const router = Router();

router.post("/:wid/:pid/agent", strictRateLimit, async (req: Request, res: Response) => {
  try {
    const { wid, pid } = req.params as { wid: string; pid: string };
    // Owner-only: provisioning acts within the caller's own workspace lane.
    if (wid !== req.workspaceSlug) {
      res.status(403).json({ error: "Not your workspace" });
      return;
    }
    const result = await provisionProjectAgent(
      { uid: req.uid!, workspaceId: req.workspaceSlug },
      pid,
    );
    res.status(result.status).json(result.body);
  } catch (err) {
    logger.error("[project-agent] Provisioning failed:", { err });
    res.status(500).json({ error: "Failed to provision project agent" });
  }
});

export default router;
