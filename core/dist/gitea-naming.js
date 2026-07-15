export const WORKSPACE_REPO = "workspace";
export const SYSTEM_CONFIG_REPO = "system_config";
export function workspaceGiteaOrg(slug) {
    return slug;
}
export function workspaceRepoName() {
    return WORKSPACE_REPO;
}
export function systemConfigRepoName() {
    return SYSTEM_CONFIG_REPO;
}
export function projectRepoName(projectSlug) {
    return projectSlug;
}
export function giteaUsername(slug) {
    return `ws-${slug}`;
}
