import { Router } from "express";
import { logger } from "../middleware/logging.js";
import { authorizeChannelAgentReadiness } from "../lib/channel-agent-readiness-authorization-broker.js";
import { readChannelAgentReadiness } from "../lib/channel-agent-readiness.js";

export function createChannelAgentReadinessRouter(deps = {
  authorize: authorizeChannelAgentReadiness,
  read: readChannelAgentReadiness,
  localGatewayId: () => process.env.GATEWAY_ID,
}) {
  const router = Router({ mergeParams: true });
  router.get<{ gatewayId: string; channelId: string }>("/:channelId", async (req, res) => {
    const gatewayId = req.params.gatewayId;
    const channelId = req.params.channelId;
    if (typeof gatewayId !== "string" || gatewayId !== deps.localGatewayId() ||
        typeof channelId !== "string" || !/^[a-z0-9]{26}$/u.test(channelId)) {
      res.status(404).json({ error: "not_found" }); return;
    }
    try {
      const access = await deps.authorize({ gatewayId, channelId, authorization: req.get("authorization") });
      if (access.kind === "unauthenticated") { res.status(401).json({ error: "Unauthenticated" }); return; }
      if (access.kind === "not_found") { res.status(404).json({ error: "not_found" }); return; }
      const scope = access.authorization;
      const ready = await deps.read({
        workspaceId: scope.workspaceId, project: scope.project,
        channelId, agentId: scope.agentId, peerKind: scope.peerKind,
      });
      res.set("cache-control", "no-store").json({ channelId, agentMmUserId: scope.agentMmUserId, ready });
    } catch (error) {
      logger.error("[channel-agent-readiness] Runtime check failed", { err: error });
      res.status(503).json({ error: "Agent readiness unavailable" });
    }
  });
  return router;
}
