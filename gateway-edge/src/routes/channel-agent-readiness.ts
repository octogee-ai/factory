import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { logger } from "../middleware/logging.js";
import { db } from "../lib/db.js";
import { authorizeChannel } from "../lib/channel-session-authorization.js";
import { readChannelAgentReadiness } from "../lib/channel-agent-readiness.js";

export function createChannelAgentReadinessRouter(deps = {
  authorize: authorizeChannel,
  read: readChannelAgentReadiness,
  localGatewayId: () => process.env.GATEWAY_ID,
  ownerGatewayId: async (uid: string): Promise<unknown> =>
    (await db.doc(`users/${uid}`).get()).data()?.provisioning?.openclaw?.gatewayId,
}) {
  const router = Router({ mergeParams: true });
  router.get("/:channelId", requireAuth, async (req, res) => {
    const gatewayId = req.params.gatewayId;
    const channelId = req.params.channelId;
    if (typeof gatewayId !== "string" || gatewayId !== deps.localGatewayId() ||
        typeof channelId !== "string" || !/^[a-z0-9]{26}$/u.test(channelId)) {
      res.status(404).json({ error: "not_found" }); return;
    }
    try {
      const access = await deps.authorize(req.uid!, channelId);
      if (!access || access.forbidden) { res.status(404).json({ error: "not_found" }); return; }
      if (await deps.ownerGatewayId(access.target.ownerUid) !== gatewayId) {
        res.status(404).json({ error: "not_found" }); return;
      }
      const channel = await access.client.getJson(["channels", channelId]) as { type?: string; delete_at?: number };
      if (channel.delete_at || !["O", "P"].includes(channel.type ?? "")) { res.status(404).json({ error: "not_found" }); return; }
      const ready = await deps.read({
        workspaceId: access.target.workspaceSlug, project: access.target.projectId ?? null,
        channelId, agentId: access.target.agentId,
        peerKind: channel.type === "P" ? "group" : "channel",
      });
      res.json({ channelId, agentMmUserId: access.target.agentMmUserId, ready });
    } catch (error) {
      logger.error("[channel-agent-readiness] Runtime check failed", { err: error });
      res.status(503).json({ error: "Agent readiness unavailable" });
    }
  });
  return router;
}
