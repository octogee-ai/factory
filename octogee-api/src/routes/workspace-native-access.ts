import { Router, type Request } from "express";
import type { Firestore } from "firebase-admin/firestore";
import { gatewayAuthorizationFromRootDocument } from "@octogee/core/gateway-live-release";
import { isCanonicalWorkspaceMembership, workspacePermissionsEnabled } from "@octogee/core/gateway-principal-access";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import { principalAccess, workspaceScopeFor, type DocumentReader } from "../../../gateway-edge/src/routes/builder/gateways.js";

function workspaceAccessClaim(req: Request): { gatewayId: string; targetUid?: string } | null {
  const body = req.body;
  const gatewayId = body?.gatewayId;
  const targetUid = body?.targetUid;
  if (req.boundTenant?.kind !== "gateway" || !isValidGatewayId(gatewayId) || gatewayId !== req.boundTenant.gatewayId) return null;
  if (!body || Object.keys(body).some(key => !["gatewayId", "targetUid"].includes(key))) return null;
  if (targetUid !== undefined && (typeof targetUid !== "string" || !targetUid || targetUid.length > 128 || targetUid.includes("/"))) return null;
  return { gatewayId, targetUid };
}

export function createWorkspaceNativeAccessRoutes({ db }: { db: Firestore }): Router {
  const router = Router();
  router.post("/workspace-access", async (req: Request, res, next) => {
    try {
      const claim = workspaceAccessClaim(req);
      if (!claim) { res.status(403).json({ error: "forbidden" }); return; }
      const { gatewayId, targetUid } = claim;
      if (!req.uid) { res.status(401).json({ error: "Unauthenticated" }); return; }
      const get: DocumentReader = path => db.doc(path).get();
      const root = await get(`gateways/${gatewayId}`);
      const auth = root.exists ? gatewayAuthorizationFromRootDocument(root.data(), gatewayId) : null;
      if (!auth) { res.status(404).json({ error: "not_found" }); return; }
      const scope = await workspaceScopeFor(auth, auth.config.builderSlug, get, true);
      if (!scope) { res.status(404).json({ error: "not_found" }); return; }
      const owner = await get(`users/${scope.ownerUid}`);
      if (!workspacePermissionsEnabled(auth.config, owner.data() ?? {})) {
        res.status(403).json({ error: "builder_workspace_required" }); return;
      }
      const access = await principalAccess(scope, req.uid, get);
      if (access.kind === "denied") { res.status(403).json({ error: "forbidden" }); return; }
      if (targetUid && targetUid !== scope.ownerUid && !isCanonicalWorkspaceMembership((await get(`workspaces/${scope.workspaceSlug}/members/${targetUid}`)).data())) {
        res.status(404).json({ error: "member_not_found" }); return;
      }
      res.set("cache-control", "no-store").json({ uid: req.uid, gatewayId, workspaceSlug: scope.workspaceSlug, ...(targetUid ? { targetUid } : {}) });
    } catch (error) { next(error); }
  });
  return router;
}
