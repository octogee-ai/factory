/**
 * Canonical Channel type — a Firestore pointer to a Mattermost channel.
 *
 * Stored at `workspaces/{wid}/channels/{cid}` (workspace-level) or
 * `workspaces/{wid}/projects/{pid}/channels/{cid}` (project-level). Per
 * DATA-MODEL-REVIEW v3 §6.3.
 *
 * MVP seeds exactly one channel per parent (kind = 'general'); the
 * subcollection shape is in place so adding focused channels later
 * requires zero schema change.
 */

export type ChannelKind = 'general';

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
