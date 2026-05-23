export interface AgentMattermost {
  
  userId: string;
}

export interface Agent {
  
  id: string;
  
  name: string;
  
  persona: string;
  
  avatarEmoji: string;
  mattermost: AgentMattermost;
  createdAt: unknown; 
  updatedAt: unknown; 
}
