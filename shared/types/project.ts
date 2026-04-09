/**
 * Canonical Project type — used by both frontend (app/) and backend (workspace-api/).
 *
 * Stored in Firestore at `projects/{workspaceSlug}_{slug}`.
 * MM channel naming: `{workspaceSlug}-{slug}`
 * Gitea repo naming: `{workspaceSlug}-{slug}`
 */

export type ProjectVisibility = 'private' | 'public' | 'unlisted';
export type ProjectStatus = 'idea' | 'building' | 'launched' | 'paused' | 'archived';
export type ProjectProvisioningState = 'provisioning' | 'active' | 'failed';
export type ProjectCanvasMode = 'markdown' | 'preview';
export type ProjectType = 'game' | 'social' | 'planner' | 'trip' | 'other';

export interface Project {
  id: string;
  ownerUid: string;
  workspaceSlug: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  projectType: ProjectType | null;
  status: ProjectStatus;
  visibility: ProjectVisibility;
  provisioningState: ProjectProvisioningState;
  guestUids: string[];
  mmChannelId: string | null;
  giteaRepoName: string | null;
  canvasMode: ProjectCanvasMode;
  canvasFile: string;
  previewUrl: string | null;
  starCount: number;
  commentCount: number;
  createdAt: unknown; // Firestore Timestamp
  updatedAt: unknown; // Firestore Timestamp
}
