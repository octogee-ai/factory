

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

export function giteaUsername(slug: string): string {
  return `ws-${slug}`;
}
