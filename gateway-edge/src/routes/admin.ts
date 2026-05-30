import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { logger } from "../middleware/logging.js";
import { db, FieldValue } from "../lib/db.js";
import { liftSuppression } from "../lib/email-suppression.js";
import { updateCSIForUser } from "../csi/updater.js";
import { getWorkspaceMmContext } from "../lib/mattermost-context.js";
import { workspaceSlugsForUser } from "../../../scripts/lib/workspace-slugs.js";
import { provisionGatewayAuthSecret } from "../../../scripts/lib/secret-manager.js";
import { listGatewayBuilds } from "../../../scripts/lib/artifact-registry.js";
import { addAdminFleetRoutes } from "../../../scripts/lib/admin-fleet-router.js";
import {
  addAdminCustomerRoutes,
  type CsiRefreshResult,
} from "../../../scripts/lib/admin-customer-router.js";
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
  refreshCsiForUser: async (uid): Promise<CsiRefreshResult> => {
    const updated = await updateCSIForUser(uid);
    return { ok: !!updated, updatedAt: updated ? updated.updatedAt : null };
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
