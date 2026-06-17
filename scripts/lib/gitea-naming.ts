

export const WORKSPACE_REPO = "workspace";
export const SYSTEM_CONFIG_REPO = "system_config";

export function workspaceGiteaOrg(slug: string): string {
  return slug;
}

export function workspaceRepoName(): string {
  return WORKSPACE_REPO;
}

export function systemConfigRepoName(): string {
  return SYSTEM_CONFIG_REPO;
}

export function projectRepoName(projectSlug: string): string {
  return projectSlug;
}

export function giteaUsername(slug: string): string {
  return `ws-${slug}`;
}
