import type { Firestore } from "firebase-admin/firestore";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { gatewayAuthorizationFromRootDocument } from "@octogee/core/gateway-live-release";
import { workspacePermissionsEnabled } from "@octogee/core/gateway-principal-access";
import { principalAccess, workspaceScopeFor, type DocumentReader } from "../routes/builder/gateways.js";

export async function connectorReviewerHasWorkspaceAccess(db: Firestore, data: Record<string, unknown>, uid: string): Promise<boolean> {
  if (typeof data.ownerUid !== "string" || typeof data.gatewayId !== "string") return false;
  const get: DocumentReader = path => db.doc(path).get();
  const [owner, reviewer] = await Promise.all([db.doc(`users/${data.ownerUid}`).get(), db.doc(`users/${uid}`).get()]);
  if (!accountAllowsInteractiveAccess(owner.data()) || !accountAllowsInteractiveAccess(reviewer.data())) return false;
  if (uid === data.ownerUid) return true;
  const root = await get(`gateways/${data.gatewayId}`);
  const auth = root.exists ? gatewayAuthorizationFromRootDocument(root.data(), data.gatewayId) : null;
  if (!auth || !workspacePermissionsEnabled(auth.config, owner.data() ?? {})) return false;
  const scope = await workspaceScopeFor(auth, auth.config.builderSlug, get, true);
  if (!scope || scope.ownerUid !== data.ownerUid || data.agentId !== `octogee-${scope.workspaceSlug}-coach`) return false;
  return (await principalAccess(scope, uid, get)).kind === "member";
}
