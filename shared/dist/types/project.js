export const PROJECT_RECIPE_IDS = [
    'static-site',
    'vite-static',
    'astro-static',
];
export const DEFAULT_PROJECT_RECIPE = 'static-site';
export function isProjectRecipeId(value) {
    return typeof value === 'string'
        && PROJECT_RECIPE_IDS.includes(value);
}
export function defaultProjectRecipe(projectType) {
    switch (projectType) {
        case 'game':
        case 'social':
        case 'planner':
            return 'vite-static';
        case 'trip':
        case 'research':
        case 'event':
            return 'astro-static';
        default:
            return DEFAULT_PROJECT_RECIPE;
    }
}
export function projectCheckoutEnabled(value) {
    return value !== false;
}
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
