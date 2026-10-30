import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { logger } from "../../middleware/logging.js";
import { provisionProjectAgent } from "../../lib/project-agent-service.js";
import { withProject } from '../../lib/withProject.js';
import { FieldValue } from '../../lib/db.js';
import { isTalkVoiceId } from '@octogee/shared/types/voice';
import { projectAgentConfigured } from '@octogee/shared/types/project';

const router = Router();

router.put('/:wid/:pid/agent/voice', strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  const body = req.body ?? {};
  if (!isTalkVoiceId(body.voice) || Object.keys(body).some(key => key !== 'voice')) {
    res.status(400).json({ error: 'Invalid project agent voice' }); return;
  }
  await withProject(req, res, wid, pid, { ownerOnly: true, requireActive: true }, async ctx => {
    if (!projectAgentConfigured(ctx.project.agent)) { res.status(409).json({ error: 'Project agent is not configured' }); return; }
    await ctx.projectRef.update({ 'agent.voice': body.voice, updatedAt: FieldValue.serverTimestamp() });
    res.json({ voice: body.voice });
  });
});

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
