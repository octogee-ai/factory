export interface AgentMattermost {
    userId: string;
}
export interface AgentAvatar {
    path: string;
    gcsPath: string;
    updatedAt: unknown;
}
export interface Agent {
    id: string;
    name: string;
    persona: string;
    avatar?: AgentAvatar;
    avatarVersion?: number;
    mattermost: AgentMattermost;
    createdAt: unknown;
    updatedAt: unknown;
}
