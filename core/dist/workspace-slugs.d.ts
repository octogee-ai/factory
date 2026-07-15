export interface WorkspaceSlugSource {
    username?: string | null;
    provisioning?: {
        openclaw?: {
            slug?: string | null;
        } | null;
    } | null;
}
export declare function primaryWorkspaceSlug(data: WorkspaceSlugSource | null | undefined): string | null;
export declare function workspaceSlugsForUser(data: WorkspaceSlugSource | null | undefined): string[];
