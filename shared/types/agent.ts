export interface AgentMattermost {
  
  userId: string;
}

export interface AgentAvatar {
  // Workspace-relative path of the durable avatar blob, e.g. "Scout-avatar.png".
  path: string;
  gcsPath: string;
  updatedAt: unknown;
}

export interface Agent {
  // Canonical agent identity (= the agents/{uid} doc id). The stable id that
  // @mention / DM resolution targets; rendering is by `name` (display name).
  id: string;
  // Free-form display name the Builder chooses ("Scout"); not unique. Mirrored to
  // the Mattermost bot's display_name. The MM bot username stays the deterministic
  // system id `{slug}-coach` and is never renamed.
  name: string;

  persona: string;
  avatarEmoji?: string;
  avatar?: AgentAvatar;
  avatarVersion?: number;
  mattermost: AgentMattermost;
  createdAt: unknown; 
  updatedAt: unknown; 
}
