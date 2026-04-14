/**
 * Canonical Agent type — used by both frontend (app/) and backend (workspace-api/, scripts/).
 *
 * Stored in Firestore at `agents/{uid}` (doc ID = Builder UID). 1:1 with user, forever.
 *
 * Holds the Builder's personal AI coach identity: name, persona, avatar, MM bot account.
 * Travels with the Builder across every project they own or join.
 *
 * Provisioned by `scripts/lib/provisionSteps.ts` on first workspace creation; the Mattermost
 * bot account `octogee-{username}-coach` is created at the same time.
 */

export interface AgentMattermost {
  /** MM user ID for the Agent's bot account. Posts in channels under this identity. */
  userId: string;
}

export interface Agent {
  /** Doc ID — same as the Builder's Firebase UID. */
  id: string;
  /** Display name. User-customizable. Defaults to "Octo" until set. */
  name: string;
  /** Free-form persona description. User-customizable. */
  persona: string;
  /** Single emoji used as the Agent's avatar. */
  avatarEmoji: string;
  mattermost: AgentMattermost;
  createdAt: unknown; // Firestore Timestamp
  updatedAt: unknown; // Firestore Timestamp
}
