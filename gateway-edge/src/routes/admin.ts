import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { logger } from "../middleware/logging.js";
import { db, FieldValue } from "../lib/db.js";
import { liftSuppression } from "../lib/email-suppression.js";
import { runEmailPreflight } from "../lib/email-preflight.js";
import { getResend } from "../lib/resend.js";
import { getWorkspaceMmContext } from "../lib/mattermost-context.js";
import { workspaceSlugsForUser } from "../../../scripts/lib/workspace-slugs.js";
import { provisionGatewayAuthSecret } from "../../../scripts/lib/secret-manager.js";
import { listGatewayBuilds } from "../../../scripts/lib/artifact-registry.js";
import { addAdminFleetRoutes } from "../../../scripts/lib/admin-fleet-router.js";
import { addAdminCustomerRoutes } from "../../../scripts/lib/admin-customer-router.js";
import { deleteAuthUserTolerantOfMissing as deleteAuthUserLib } from "../../../scripts/lib/firebase-auth-helpers.js";

const router = Router();
router.use(requireAdmin);

addAdminCustomerRoutes(router, {
  db,
  FieldValue,
  logger,
  workspaceSlugsForUser,
  getWorkspaceMmContext: async (uid, hint) => {
    const ctx = await getWorkspaceMmContext(uid, undefined, hint);
    return ctx ? { coachDmChannelId: ctx.coachDmChannelId } : null;
  },
});

addAdminFleetRoutes(router, {
  db,
  logger,
  workspaceSlugsForUser,
  provisionGatewayAuthSecret,
  listGatewayBuilds,
  deleteAuthUserTolerantOfMissing: async (uid: string) => {
    const { getAuth } = await import("firebase-admin/auth");
    await deleteAuthUserLib(uid, getAuth());
  },
});

// One-shot config check: Resend API key real, webhook secret real, sender
// domain verified in Resend. Used after a deploy or rotate-secret to confirm
// the full delivery path is wired before relying on email.
router.get("/email/preflight", async (_req, res) => {
  try {
    const result = await runEmailPreflight({
      env: process.env,
      listDomains: async () => {
        const resend = getResend();
        const r = await (resend.domains.list() as Promise<{
          data?: { data?: Array<{ name?: string; status?: string }> };
        }>);
        return (r.data?.data ?? [])
          .filter((d): d is { name: string; status: string } => !!d.name && !!d.status)
          .map((d) => ({ name: d.name, status: d.status }));
      },
    });
    res.json(result);
  } catch (err) {
    logger.error("[admin] email preflight failed", { err });
    res.status(500).json({ error: "preflight failed" });
  }
});

// Operator override to lift a suppression — the support case where someone
// fixed their inbox after a hard bounce / mis-marked complaint. Address is
// :addr (Express decodes the %40); normalised lowercased by liftSuppression.
router.delete("/email-suppressions/:addr", async (req, res) => {
  const addr = String(req.params.addr || "").trim();
  if (!addr.includes("@")) {
    res.status(400).json({ error: "address must contain @" });
    return;
  }
  try {
    await liftSuppression(addr);
    logger.info("[admin] suppression lifted", { addr: addr.toLowerCase() });
    res.json({ ok: true });
  } catch (err) {
    logger.error("[admin] suppression lift failed", { err, addr });
    res.status(500).json({ error: "lift failed" });
  }
});

export default router;
