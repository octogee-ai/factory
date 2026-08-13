import { Router, type NextFunction, type Request, type Response } from "express";
import { parseAgentId } from "@octogee/shared/types/identity";

import { db } from "../../lib/db.js";
import {
  resolveOwnerSystemMessageTarget,
  type OwnerSystemMessageTarget,
} from "../../lib/gateway-system-message.js";
import { requireAgentMessageAuth } from "../../middleware/agent-message-auth.js";
import { logger } from "../../middleware/logging.js";

const OPENCLAW_URL = "http://127.0.0.1:18789";
const MESSAGE_TIMEOUT_MS = 15_000;

type TargetResolver = (uid: string) => Promise<OwnerSystemMessageTarget>;

interface AgentMessageInput {
  uid: string;
  agentId: string;
  message: string;
}

function requestString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function validUid(uid: string): boolean {
  return Boolean(uid) && uid.length <= 128 && !uid.includes("/") && uid.trim() === uid;
}

function agentMessageInput(body: unknown): AgentMessageInput | null {
  const input = body && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
  const uid = requestString(input.uid);
  const agentId = requestString(input.agentId);
  const message = requestString(input.message);
  if (!validUid(uid) || parseAgentId(agentId).kind !== "coach" || !message.trim()) {
    return null;
  }
  return { uid, agentId, message };
}

async function deliverAgentMessage(
  input: AgentMessageInput,
  gatewayToken: string,
): Promise<globalThis.Response> {
  return fetch(
    `${OPENCLAW_URL}/api/agents/${encodeURIComponent(input.agentId)}/message`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: input.message, source: "system" }),
      signal: AbortSignal.timeout(MESSAGE_TIMEOUT_MS),
    },
  );
}

export function createInternalAgentMessageRouter(
  resolveTarget: TargetResolver = (uid) => resolveOwnerSystemMessageTarget(db, uid),
): Router {
  const router = Router({ mergeParams: true });
  router.post(
    "/",
    requireAgentMessageAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const gatewayId = requestString(req.params.gatewayId);
        if (!gatewayId || gatewayId !== process.env.GATEWAY_ID) {
          res.status(409).json({ error: "gateway mismatch" });
          return;
        }
        const input = agentMessageInput(req.body);
        if (!input) {
          res.status(400).json({ error: "invalid agent message" });
          return;
        }
        const target = await resolveTarget(input.uid);
        if (target.gatewayId !== gatewayId || target.agentId !== input.agentId) {
          res.status(403).json({ error: "agent message target rejected" });
          return;
        }
        const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
        if (!gatewayToken) {
          logger.error("internal agent message delivery failed", {
            gatewayId,
            agentId: input.agentId,
            error: "local OpenClaw credential unavailable",
          });
          res.status(503).json({ error: "OpenClaw message delivery unavailable" });
          return;
        }
        const response = await deliverAgentMessage(input, gatewayToken);
        if (!response.ok) {
          logger.error("internal agent message delivery failed", {
            gatewayId,
            agentId: input.agentId,
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
  return router;
}

export default createInternalAgentMessageRouter();
