export type ChannelKind = 'general' | 'coach-dm' | 'admin';

export interface ChannelMattermost {
  
  channelId: string;

activityChannelId?: string;
}

export interface Channel {
  
  id: string;
  kind: ChannelKind;
  
  name: string;
  mattermost: ChannelMattermost;
  createdAt: unknown; 
}
