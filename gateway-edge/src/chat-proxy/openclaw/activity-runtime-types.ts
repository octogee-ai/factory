export interface AgentIdentity {
  agentId: string;
  uid: string;
  coachMmUserId: string;
  coachToken: string;
  workspaceSlug: string;
  projectSlug: string;
}

export interface ChannelTarget {
  primaryChannelId: string;
  channelDocPath: string;
}

export interface AuthorizedConversationTarget extends ChannelTarget {
  expectedChannelTeamId: string | null;
  expectedChannelName: string | null;
  expectedChannelType: "P" | "D";
  expectedMemberIds?: string[];
}

export interface MmPostInput {
  channelId: string;
  rootId?: string;
  message: string;
  props?: Record<string, unknown>;
  pendingPostId?: string;
}

export interface MmClient {
  createPost(input: MmPostInput): Promise<{ id: string }>;
  editPost(postId: string, input: Pick<MmPostInput, "message" | "props">): Promise<void>;
  deletePost(postId: string): Promise<void>;
  withUserToken(token: string): MmClient;
}
