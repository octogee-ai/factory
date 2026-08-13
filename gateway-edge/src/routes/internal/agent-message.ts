import { Router, type NextFunction, type Request, type Response } from "express";
import { parseAgentId } from "@octogee/shared/types/identity";

import { requireBuilderShellInternalAuth } from "../../middleware/builder-shell-auth.js";
import { logger } from "../../middleware/logging.js";

const router = Router({ mergeParams: true });
const OPENCLAW_URL = "http://127.0.0.1:18789";
const MESSAGE_TIMEOUT_MS = 15_000;

router.post(
  "/",
  requireBuilderShellInternalAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const gatewayId = typeof req.params.gatewayId === "string" ? req.params.gatewayId : "";
      if (!gatewayId || gatewayId !== process.env.GATEWAY_ID) {
        res.status(409).json({ error: "gateway mismatch" });
        return;
      }
      const agentId = typeof req.body?.agentId === "string" ? req.body.agentId : "";
      const message = typeof req.body?.message === "string" ? req.body.message : "";
      if (parseAgentId(agentId).kind === "unknown" || !message.trim()) {
        res.status(400).json({ error: "invalid agent message" });
        return;
      }
      const response = await fetch(
        `${OPENCLAW_URL}/api/agents/${encodeURIComponent(agentId)}/message`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, source: "system" }),
          signal: AbortSignal.timeout(MESSAGE_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        logger.error("internal agent message delivery failed", {
          gatewayId,
          agentId,
          status: response.status,
        });
        res.status(502).json({ error: "OpenClaw message delivery failed" });
        return;
      }
      res.sendStatus(204);
    } catch (error) {
      logger.error("internal agent message delivery failed", {
        gatewayId: req.params.gatewayId,
        error: error instanceof Error ? error.message : String(error),
      });
      next(error);
    }
  },
);

export default router;
