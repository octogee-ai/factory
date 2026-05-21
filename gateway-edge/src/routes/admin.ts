import { Router } from "express";
import { requireAdmin } from "../middleware/auth";
import { logger } from "../middleware/logging";
import { db, FieldValue } from "../lib/db";
import { updateCSIForUser } from "../csi/updater";
import { getWorkspaceMmContext } from "../lib/mattermost-context";
import { workspaceSlugsForUser } from "../../../scripts/lib/workspace-slugs";
import { provisionGatewayAuthSecret } from "../../../scripts/lib/secret-manager";
import { listGatewayBuilds } from "../../../scripts/lib/artifact-registry";
import { addAdminFleetRoutes } from "../../../scripts/lib/admin-fleet-router";
import {
  addAdminCustomerRoutes,
  type CsiRefreshResult,
} from "../../../scripts/lib/admin-customer-router";
import { deleteAuthUserTolerantOfMissing as deleteAuthUserLib } from "../../../scripts/lib/firebase-auth-helpers";

const router = Router();
router.use(requireAdmin);

// Customer Customers tab + per-customer drawer. Mounted from a shared
// factory so glm-controller (Cowboy HTTP) can serve the same surface
// when no gateway pods are booted. The factory owns route definitions;
// this wiring layer injects gateway-edge's db / logger / CSI compute.
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

// Fleet / customer-lifecycle endpoints — also via shared factory (#855).
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

export default router;
