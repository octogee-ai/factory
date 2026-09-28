import { trustedBrokerBaseUrl } from './automation-authorization-broker.js';
import { internalFetch } from './internal-fetch.js';
import { WorkspaceNativeAccessError } from './workspace-native-access.js';

export interface ToolConversation {
  uid: string;
  gatewayId: string;
  workspaceSlug: string;
  channelId: string;
  agentId: string;
  sessionKey: string;
  callerMmUserId: string;
}

function validConversationIdentity(body: Partial<ToolConversation>, args: { uid: string; gatewayId: string; channelId: string; expectedAgentId?: string }): boolean {
  return body.uid === args.uid && body.gatewayId === args.gatewayId && body.channelId === args.channelId &&
    typeof body.workspaceSlug === 'string' && /^[a-z0-9-]{1,64}$/u.test(body.workspaceSlug) &&
    body.agentId === `octogee-${body.workspaceSlug}-coach` &&
    (args.expectedAgentId === undefined || body.agentId === args.expectedAgentId) &&
    ['group', 'channel'].some(kind => body.sessionKey === `agent:${body.agentId}:mattermost:${kind}:${args.channelId}`);
}

export async function resolveToolConversationForUid(args: {
  uid: string; gatewayId: string; channelId: string; expectedAgentId?: string;
  env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;
}): Promise<ToolConversation> {
  const env = args.env ?? process.env;
  const rawBase = env.OPENCLAW_RUNTIME_BROKER_URL;
  if (!rawBase) throw new Error('OPENCLAW_RUNTIME_BROKER_URL is required');
  const base = trustedBrokerBaseUrl(rawBase, env);
  const response = await internalFetch(`${base}/internal/openclaw-control/tool-conversation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
    body: JSON.stringify({ uid: args.uid, gatewayId: args.gatewayId, channelId: args.channelId }),
  }, { fetchImpl: args.fetchImpl, requireProjectedToken: true, timeoutMs: 5000 });
  if (!response.ok) throw new WorkspaceNativeAccessError([401, 403, 404].includes(response.status) ? response.status : 503, 'Tool conversation unavailable');
  const body = await response.json() as Partial<ToolConversation>;
  if (!validConversationIdentity(body, args) || typeof body.callerMmUserId !== 'string' || !/^[a-z0-9]{26}$/u.test(body.callerMmUserId)) {
    throw new Error('Tool conversation broker returned an invalid context');
  }
  const { uid, gatewayId, workspaceSlug, channelId, agentId, sessionKey, callerMmUserId } = body as ToolConversation;
  return { uid, gatewayId, workspaceSlug, channelId, agentId, sessionKey, callerMmUserId };
}
