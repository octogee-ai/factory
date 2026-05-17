/**
 * Single source of truth for Gitea org + repo naming.
 *
 * One Gitea org per workspace, named for the workspace slug — 1:1 with the
 * MM team and the GitHub org. Repo names are bare (no slug prefix) because
 * the org now provides the namespace: `{slug}/workspace`, `{slug}/{project}`.
 */

export const WORKSPACE_REPO = "workspace";

export function workspaceGiteaOrg(slug: string): string {
  return slug;
}

export function workspaceRepoName(): string {
  return WORKSPACE_REPO;
}

export function projectRepoName(projectSlug: string): string {
  return projectSlug;
}

/** Per-builder Gitea user. One per workspace, member of the org's write team. */
export function giteaUsername(slug: string): string {
  return `ws-${slug}`;
}
