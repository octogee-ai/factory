export declare function projectAgentWorkspace(customerDir: string, project: string): string;
interface ProjectAgentWorkspaceSync {
    customerDir: string;
    slug: string;
    projects: readonly string[];
    checkpointEpoch?: number;
    assertCurrent?: () => Promise<void>;
}
interface GitTransport {
    remote: string;
    ssh: string;
}
export declare function projectAgentRepoTransport({ slug, customerDir }: Pick<ProjectAgentWorkspaceSync, "slug" | "customerDir">): GitTransport;
export declare function initializeRelocatedProjectAgent(input: {
    customerDir: string;
    project: string;
    name: string;
    emoji: string;
}): Promise<void>;
export declare function restoreProjectAgentWorkspaces(input: ProjectAgentWorkspaceSync, transport?: GitTransport): Promise<void>;
export declare function saveProjectAgentWorkspaces(input: ProjectAgentWorkspaceSync, transport?: GitTransport): Promise<void>;
export {};
