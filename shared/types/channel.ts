/**
 * Canonical Channel type — a Firestore pointer to a Mattermost channel.
 *
 * Stored at `workspaces/{wid}/channels/{cid}` (workspace-level) or
 * `workspaces/{wid}/projects/{pid}/channels/{cid}` (project-level). Per
 * DATA-MODEL-REVIEW v3 §6.3.
 *
 * Project-level channels are always kind = 'general' (MVP seeds one).
 * Workspace-level channels can be any of 'general' / 'coach-dm' / 'admin',
 * seeded at provisioning time by scripts/lib/provisionSteps.ts.
 */

export type ChannelKind = 'general' | 'coach-dm' | 'admin';

export interface ChannelMattermost {
  /** MM channel ID for this channel. */
  channelId: string;
}

export interface Channel {
  /** Doc ID = caller-chosen. MVP uses 'general' for the seed channel. */
  id: string;
  kind: ChannelKind;
  /** Display name for the channel UI. */
  name: string;
  mattermost: ChannelMattermost;
  createdAt: unknown; // Firestore Timestamp
}
