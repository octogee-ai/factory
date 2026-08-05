export type ProjectVisibility = 'private' | 'public' | 'unlisted';
export type ProjectStatus = 'idea' | 'building' | 'launched' | 'paused' | 'archived';
export type ProjectProvisioningState = 'provisioning' | 'active' | 'failed';
export type ProjectType = 'game' | 'social' | 'planner' | 'trip' | 'other';
export type ProjectRecipeId = 'static-site' | 'vite-static' | 'astro-static';
export declare const DEFAULT_PROJECT_RECIPE: ProjectRecipeId;
export interface ProjectRepoSource {
    provider: 'github';
    owner: string;
    repo: string;
}
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
