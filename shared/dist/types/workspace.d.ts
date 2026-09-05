import type { WorkspaceVibe } from './display-names.js';
export type WorkspaceVisibility = 'public' | 'private' | 'unlisted';
export interface WorkspaceMattermost {
    teamId: string;
}
export interface WorkspaceGitea {
    orgName: string;
    repoName: string;
}
export interface Workspace {
    id: string;
    ownerUid: string;
    slug: string;
    name: string;
    ownerDisplayName: string;
    visibility: WorkspaceVisibility;
    gatewayAccessMode?: 'personal' | 'team';
    vibe?: WorkspaceVibe;
    mattermost: WorkspaceMattermost;
    gitea: WorkspaceGitea;
    createdAt: unknown;
    updatedAt: unknown;
}
