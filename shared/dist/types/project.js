export const DEFAULT_PROJECT_RECIPE = 'static-site';
export function projectRepoSourceFromDoc(value) {
    if (!value || typeof value !== 'object')
        return null;
    const { provider, owner, repo } = value;
    if (provider !== 'github')
        return null;
    if (typeof owner !== 'string' || owner.length === 0)
        return null;
    if (typeof repo !== 'string' || repo.length === 0)
        return null;
    return { provider: 'github', owner, repo };
}
