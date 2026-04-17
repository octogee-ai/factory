/**
 * Canonical Workspace type — used by both frontend and backend.
 *
 * Stored in Firestore at `workspaces/{username}` (doc ID = the Builder's username).
 * 1:1 with the user, forever. Other Builders join into this workspace via
 * `workspaces/{wid}/members/{uid}` (subcollection). The username IS the
 * workspace slug AND the Builder's display handle in MM/Gitea/URL — per
 * DATA-MODEL-REVIEW v3 §2.
 */

import type { WorkspaceVibe } from './display-names';

export type WorkspaceVisibility = 'public' | 'private' | 'unlisted';

export interface WorkspaceMattermost {
  /** MM team ID for this workspace. One team per workspace. */
  teamId: string;
}

export interface WorkspaceGitea {
  /** Gitea org name. Equal to the username. */
  orgName: string;
  /** Workspace repo name (`{username}-workspace`). */
  repoName: string;
}

export interface Workspace {
  /** Doc ID = username. Also the URL slug, MM team name, Gitea org name, owner display name. */
  id: string;
  ownerUid: string;
  /** Equal to `id`. Carried for callers that read the field directly. */
  slug: string;
  /** Display name. Equal to `id` (username) — denorm per v3 to skip a join. */
  name: string;
  /** Owner display name. Equal to `id` (username) — denorm. */
  ownerDisplayName: string;
  visibility: WorkspaceVisibility;
  /** Vibe — drives both MM team display_name and coach-typing-phrase
   * personalization. Reads fall back to DEFAULT_VIBE_NOUN / DEFAULT_TYPING_PHRASES
   * when the field is absent (Builder skipped the picker or new workspace
   * pre-vibe-step). Stored lowercase ('office', 'garage', …). */
  vibe?: WorkspaceVibe;
  mattermost: WorkspaceMattermost;
  gitea: WorkspaceGitea;
  createdAt: unknown; // Firestore Timestamp
  updatedAt: unknown; // Firestore Timestamp
}
