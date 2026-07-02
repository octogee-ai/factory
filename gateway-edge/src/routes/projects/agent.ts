import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { logger } from "../../middleware/logging.js";
import { setProjectAgentEnabled } from "../../lib/project-agent-service.js";

const router = Router();

router.post("/:wid/:pid/agent", strictRateLimit, async (req: Request, res: Response) => {
  try {
    const { wid, pid } = req.params as { wid: string; pid: string };
    // Owner-only: the toggle acts within the caller's own workspace lane.
    if (wid !== req.workspaceSlug) {
      res.status(403).json({ error: "Not your workspace" });
      return;
    }
    // Disable retires the bot and revokes its tokens — destructive enough
    // that a malformed payload must not silently mean "off".
    if (typeof req.body?.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    const enabled = req.body.enabled === true;
    const result = await setProjectAgentEnabled(
      { uid: req.uid!, userData: req.user, workspaceId: req.workspaceSlug },
      pid,
      enabled,
    );
    res.status(result.status).json(result.body);
  } catch (err) {
    logger.error("[project-agent] Toggle failed:", { err });
    res.status(500).json({ error: "Failed to update project agent" });
  }
});

export default router;
