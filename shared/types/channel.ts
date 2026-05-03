export type ChannelKind = 'general' | 'coach-dm' | 'admin';

export interface ChannelMattermost {
  /** MM channel ID for this channel. */
  channelId: string;
  /**
   * MM channel ID for the paired activity sibling. Optional during the
   * Activity Stream Phase 1 rollout — channels created before the
   * provisioner change won't have it; the bridge falls through gracefully.
   * See docs/ACTIVITY-STREAM-SPEC.md §4.1.
   */
  activityChannelId?: string;
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
