import type { PlatformStateRepositories } from "@octogee/core/platform-state";

import { builderAllowsInteractiveAccess } from "./assigned-builder.js";

export async function resolveActiveArtifactWorkspaceSlug(
  store: Pick<PlatformStateRepositories, "builders" | "workspaces">,
  mattermostTeamId: string,
): Promise<{ workspaceSlug: string; workspaceOwnerUid: string } | null> {
  const workspace = await store.workspaces.records.findByMattermostTeamId(mattermostTeamId);
  if (!workspace) return null;
  const owner = await store.builders.records.get(workspace.ownerUid);
  return owner && builderAllowsInteractiveAccess(owner)
    ? { workspaceSlug: workspace.slug, workspaceOwnerUid: workspace.ownerUid }
    : null;
}
