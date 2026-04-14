/**
 * Canonical Project type — used by both frontend (app/) and backend.
 *
 * Stored in Firestore at `workspaces/{workspaceId}/projects/{slug}`
 * (doc ID = the user-chosen project slug). Per DATA-MODEL-REVIEW v3 §6.11.
 *
 * MM channel naming: `{workspaceId}-proj-{slug}-general` (moved into a
 * channels subcollection per v3 §6.3; doc: `channels/{cid}`).
 * Gitea repo naming: `{workspaceId}-proj-{slug}`.
 *
 * Membership lives in the `members/{uid}` subcollection (v3 §6.10) —
 * no `guestUids[]` array on the doc.
 */

export type ProjectVisibility = 'private' | 'public' | 'unlisted';
export type ProjectStatus = 'idea' | 'building' | 'launched' | 'paused' | 'archived';
export type ProjectProvisioningState = 'provisioning' | 'active' | 'failed';
export type ProjectCanvasMode = 'markdown' | 'preview';
export type ProjectType = 'game' | 'social' | 'planner' | 'trip' | 'other';

export interface Project {
  /** Doc ID = slug. */
  id: string;
  ownerUid: string;
  /** Workspace ID — equal to the owner's username. */
  workspaceId: string;
  /** User-chosen slug — `^[a-z][a-z0-9-]{2,15}$`, unique within the workspace. */
  slug: string;
  /** User-typed display name (free-form). */
  name: string;
  tagline: string;
  description: string;
  category: string;
  projectType: ProjectType | null;
  status: ProjectStatus;
  visibility: ProjectVisibility;
  provisioningState: ProjectProvisioningState;
  giteaRepoName: string | null;
  canvasMode: ProjectCanvasMode;
  canvasFile: string;
  previewUrl: string | null;
  starCount: number;
  memberCount: number;
  createdAt: unknown; // Firestore Timestamp
  updatedAt: unknown; // Firestore Timestamp
}
