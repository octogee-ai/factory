export type ProjectVisibility = 'private' | 'public' | 'unlisted';
export type ProjectStatus = 'idea' | 'building' | 'launched' | 'paused' | 'archived';
export type ProjectProvisioningState = 'provisioning' | 'active' | 'failed';
export type ProjectType = 'game' | 'social' | 'planner' | 'trip' | 'research' | 'event' | 'other';
export type ProjectRecipeId = 'static-site' | 'vite-static' | 'astro-static';
export declare const PROJECT_RECIPE_IDS: readonly ProjectRecipeId[];
export declare const DEFAULT_PROJECT_RECIPE: ProjectRecipeId;
export declare function isProjectRecipeId(value: unknown): value is ProjectRecipeId;
export declare function defaultProjectRecipe(projectType: string | null): ProjectRecipeId;
export interface ProjectRepoSource {
    provider: 'github';
    owner: string;
    repo: string;
}
export declare function projectCheckoutEnabled(value: unknown): boolean;
export declare function projectRepoSourceFromDoc(value: unknown): ProjectRepoSource | null;
export interface Project {
    id: string;
    ownerUid: string;
    workspaceId: string;
    slug: string;
    name: string;
    tagline: string;
    description: string;
    category: string;
    projectType: ProjectType | null;
    status: ProjectStatus;
    visibility: ProjectVisibility;
    provisioningState: ProjectProvisioningState;
    provisioningError?: string | null;
    pendingVisibility?: ProjectVisibility | null;
    giteaRepoName: string | null;
    repoSource?: ProjectRepoSource | null;
    /** Owner-controlled: should this project be checked out on the Builder's gateway?
     *  Distinct from provisioningState, which is the server's record of what provisioning
     *  did. A repo the gateway cannot reach (a GitHub project on a shared pod) is turned
     *  off here rather than misreported as a provisioning failure. Absent means enabled. */
    checkoutEnabled?: boolean;
    commercialLifecycle?: {
        status: "active" | "archived";
        archivedAt?: unknown;
    };
    canvasFile: string;
    recipe?: ProjectRecipeId | null;
    publishedUrl: string | null;
    starCount: number;
    memberCount: number;
    createdAt: unknown;
    updatedAt: unknown;
}
