interface MattermostChannel {
    id: string;
    name?: string;
    delete_at?: number;
}
export declare function createOrRestoreChannel(teamId: string, name: string, displayName: string, type: string, purpose: string): Promise<MattermostChannel | null>;
export declare function createProjectChannel(teamId: string, // workspace team ID (Phase 4: team-per-workspace)
slug: string, projectSlug: string, customerMmUserId: string, projectName: string): Promise<string | null>;
export {};
