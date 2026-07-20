import type { Firestore } from "firebase-admin/firestore";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";

export async function resolveActiveArtifactWorkspaceSlug(
  db: Pick<Firestore, "collection">,
  mattermostTeamId: string,
): Promise<{ workspaceSlug: string; workspaceOwnerUid: string } | null> {
  const workspaces = await db
    .collection("workspaces")
    .where("mattermost.teamId", "==", mattermostTeamId)
    .limit(2)
    .get();
  if (workspaces.docs.length > 1) {
    throw new Error(`Mattermost team ${mattermostTeamId} maps to multiple workspaces`);
  }
  const workspace = workspaces.docs[0];
  if (!workspace) return null;
  const ownerUid = (workspace.data() as { ownerUid?: unknown }).ownerUid;
  if (typeof ownerUid !== "string") {
    throw new Error(`Workspace ${workspace.id} has no owner uid`);
  }
  const owner = await db.collection("users").doc(ownerUid).get();
  return owner.exists && accountAllowsInteractiveAccess(owner.data())
    ? { workspaceSlug: workspace.id, workspaceOwnerUid: ownerUid }
    : null;
}
