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
