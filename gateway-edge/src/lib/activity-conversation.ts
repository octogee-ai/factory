import { accountAllowsInteractiveAccess } from '@octogee/shared/types/account-lifecycle';
import { userAssignmentMatchesGateway } from '@octogee/core/assigned-roster';
import { isValidGatewayId } from '@octogee/shared/types/glm';
import { authorizeChannel, type AuthorizedChannel, type ChannelSessionMattermostClient } from './channel-session-authorization.js';
import { ChannelSessionMattermostError } from './channel-session-model-control.js';

export interface ActivityConversation {
  gatewayId: string;
  ownerUid: string;
  channelId: string;
  threadRootPostId?: string;
  expectedAgentId: string;
  sessionKey: string;
}

interface ActivityConversationInput {
  db: { doc(path: string): { get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }> } };
  uid: string;
  channelId: string;
  threadRootPostId?: string;
  authorize?: typeof authorizeChannel;
}

async function assignedGateway(input: ActivityConversationInput, { target }: AuthorizedChannel): Promise<string | null> {
  const [owner, caller] = await Promise.all([input.db.doc(`users/${target.ownerUid}`).get(), input.db.doc(`users/${input.uid}`).get()]);
  const data = owner.data();
  if (!owner.exists || !data || !accountAllowsInteractiveAccess(data) || !caller.exists || !accountAllowsInteractiveAccess(caller.data())) return null;
  const provisioning = data.provisioning as { openclaw?: { gatewayId?: unknown } } | undefined;
  const gatewayId = provisioning?.openclaw?.gatewayId;
  if (!isValidGatewayId(gatewayId) || !userAssignmentMatchesGateway(data, gatewayId, target.workspaceSlug)) return null;
  return gatewayId;
}

async function agentIsMember(client: ChannelSessionMattermostClient, channelId: string, agentMmUserId: string): Promise<boolean> {
  try {
    const member = await client.getJson(['channels', channelId, 'members', agentMmUserId]) as Record<string, unknown>;
    return Boolean(member && member.channel_id === channelId && member.user_id === agentMmUserId);
  } catch (error) {
    if (error instanceof ChannelSessionMattermostError && [403, 404].includes(error.status ?? 0)) return false;
    throw error;
  }
}

async function threadIsInChannel(client: ChannelSessionMattermostClient, channelId: string, threadRootPostId: string): Promise<boolean> {
  try {
    const post = await client.getJson(['posts', threadRootPostId]) as Record<string, unknown>;
    return Boolean(post && post.id === threadRootPostId && post.channel_id === channelId && post.root_id === '' && post.delete_at === 0);
  } catch (error) {
    if (error instanceof ChannelSessionMattermostError && [403, 404].includes(error.status ?? 0)) return false;
    throw error;
  }
}

function isActiveChannel(channel: Record<string, unknown>, channelId: string): boolean {
  return Boolean(channel && channel.id === channelId && channel.delete_at === 0 && ['O', 'P', 'D'].includes(String(channel.type)));
}

export async function resolveActivityConversation(input: ActivityConversationInput): Promise<ActivityConversation | null> {
  const { threadRootPostId } = input;
  if (threadRootPostId !== undefined && !/^[a-z0-9]{26}$/u.test(threadRootPostId)) return null;
  const access = await (input.authorize ?? authorizeChannel)(input.uid, input.channelId, undefined, {
    requireActiveLedger: true, includeCoachConversation: true,
  });
  if (!access || access.forbidden) return null;
  const { target, client } = access;
  const gatewayId = await assignedGateway(input, access);
  if (!gatewayId) return null;
  const channel = await client.getJson(['channels', input.channelId]) as Record<string, unknown>;
  if (!isActiveChannel(channel, input.channelId)) return null;
  if (!await agentIsMember(client, input.channelId, target.agentMmUserId)) return null;
  if (threadRootPostId !== undefined && !await threadIsInChannel(client, input.channelId, threadRootPostId)) return null;
  const kinds: Record<string, string> = { D: 'direct', P: 'group', O: 'channel' };
  const kind = kinds[String(channel.type)];
  const peer = kind === 'direct' ? access.callerMmUserId : input.channelId;
  const threadSuffix = threadRootPostId === undefined ? '' : `:thread:${threadRootPostId}`;
  return {
    gatewayId, ownerUid: target.ownerUid, channelId: input.channelId, expectedAgentId: target.agentId,
    ...(threadRootPostId === undefined ? {} : { threadRootPostId }),
    sessionKey: `agent:${target.agentId}:mattermost:${kind}:${peer}${threadSuffix}`,
  };
}
