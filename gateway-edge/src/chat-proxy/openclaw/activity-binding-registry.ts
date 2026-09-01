import type { AgentActivityIngressRef } from "@octogee/shared/types/agent-conversation";
import {
  freezeActiveActivityRunBinding,
  type ActiveActivityRunBinding,
  type ActivityRuntimeRegistry,
} from "./activity-intake.js";
import type { AgentIdentity, AuthorizedConversationTarget } from "./activity-runtime-types.js";
import { parseMattermostSessionRoute } from "./mattermost-session-route.js";

export interface ActivityBindingRegistryDeps {
  resolveAgentIdentity(agentId: string): Promise<AgentIdentity | null>;
  resolveConversationTarget(
    agentId: string,
    conversationId: string,
  ): Promise<AuthorizedConversationTarget | null>;
  resolveDirectConversationTarget(
    agentId: string,
    conversationId: string,
    ownerUserId: string,
  ): Promise<AuthorizedConversationTarget | null>;
  verifyChannel(identity: AgentIdentity, target: AuthorizedConversationTarget): Promise<number>;
}

type MattermostChannelVerification = {
  baseUrl: string;
  channelId: string;
  token: string;
  expectedTeamId?: string;
  expectedName?: string;
  expectedType: "P" | "D";
  expectedMemberIds?: string[];
  fetchImpl?: typeof fetch;
};

function authorizedChannelCreateAt(
  channel: Record<string, unknown>,
  input: MattermostChannelVerification,
): number | null {
  const correctTeam = input.expectedTeamId === undefined || channel.team_id === input.expectedTeamId;
  const correctName = input.expectedName === undefined || channel.name === input.expectedName;
  const createAt = channel.create_at;
  return channel.id === input.channelId
    && correctTeam
    && correctName
    && channel.type === input.expectedType
    && Number.isSafeInteger(createAt)
    && (createAt as number) >= 0
    ? createAt as number
    : null;
}

async function verifyDirectMemberRoster(
  input: MattermostChannelVerification,
  fetchImpl: typeof fetch,
): Promise<void> {
  const expectedMemberIds = [...new Set(input.expectedMemberIds ?? [])].sort();
  if (expectedMemberIds.length !== 2) {
    throw new Error("MM direct channel binding requires exactly two expected members");
  }
  const membersResponse = await fetchImpl(
    `${input.baseUrl.replace(/\/{1,32}$/, "")}/api/v4/channels/${encodeURIComponent(input.channelId)}/members?per_page=200`,
    { headers: { authorization: `Bearer ${input.token}` } },
  );
  if (!membersResponse.ok) {
    throw new Error(`MM channel member lookup ${membersResponse.status}: ${(await membersResponse.text()).slice(0, 200)}`);
  }
  const members = await membersResponse.json() as unknown;
  if (!Array.isArray(members)) {
    throw new Error("MM channel member lookup returned a malformed roster");
  }
  const memberIds = members.map((member) =>
    member && typeof member === "object" && typeof (member as { user_id?: unknown }).user_id === "string"
      ? (member as { user_id: string }).user_id
      : null);
  const actualMemberIds = [...new Set(memberIds.filter((memberId): memberId is string => memberId !== null))].sort();
  if (
    memberIds.includes(null)
    || memberIds.length !== expectedMemberIds.length
    || JSON.stringify(actualMemberIds) !== JSON.stringify(expectedMemberIds)
  ) {
    throw new Error("MM direct channel roster does not match Agent and owner");
  }
}

export async function readMattermostChannelCreateAt(input: MattermostChannelVerification): Promise<number> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${input.baseUrl.replace(/\/{1,32}$/, "")}/api/v4/channels/${encodeURIComponent(input.channelId)}`,
    { headers: { authorization: `Bearer ${input.token}` } },
  );
  if (!response.ok) {
    throw new Error(`MM channel lookup ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const channel = await response.json() as Record<string, unknown>;
  const createAt = authorizedChannelCreateAt(channel, input);
  if (createAt === null) {
    throw new Error("MM channel lookup returned an unauthorized binding");
  }
  if (input.expectedType === "D") {
    await verifyDirectMemberRoster(input, fetchImpl);
  } else if (input.expectedMemberIds !== undefined) {
    throw new Error("MM private channel binding cannot carry a direct roster");
  }
  return createAt;
}

function nonBlank(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function validLineage(ref: AgentActivityIngressRef): boolean {
  if (ref.origin === "retry") {
    return !ref.parentRunId && nonBlank(ref.retryOfRunId) && ref.retryOfRunId !== ref.runId;
  }
  if (ref.origin === "subagent") {
    return !ref.parentRunId && !ref.retryOfRunId;
  }
  return !ref.parentRunId && !ref.retryOfRunId;
}

function validRoute(ref: AgentActivityIngressRef): boolean {
  if (
    ref.conversationId !== ref.mainChannelId ||
    ref.turnId !== ref.mainRootPostId ||
    !validLineage(ref)
  ) {
    return false;
  }
  if (ref.origin === "subagent") {
    return ref.sessionKey.startsWith(`agent:${ref.agentId}:subagent:`) && nonBlank(ref.inputPostId);
  }
  if (ref.origin === "scheduled") {
    return ref.sessionKey.startsWith(`agent:${ref.agentId}:`) &&
      parseMattermostSessionRoute(ref.sessionKey) === null;
  }
  const route = parseMattermostSessionRoute(ref.sessionKey);
  if (
    !route ||
    route.agentId !== ref.agentId ||
    route.threadRootPostId !== ref.mainRootPostId
  ) {
    return false;
  }
  return route.peerKind === "direct" || route.primaryChannelId === ref.mainChannelId;
}

function authoritativeTarget(
  ref: AgentActivityIngressRef,
  identity: AgentIdentity,
  target: AuthorizedConversationTarget,
): boolean {
  const route = parseMattermostSessionRoute(ref.sessionKey);
  const directTarget = isAuthoritativeDirectTarget(route, identity, target);
  const channelTarget = isAuthoritativePrivateTarget(route, target);
  return (
    identity.agentId === ref.agentId &&
    nonBlank(identity.coachToken) &&
    nonBlank(identity.workspaceSlug) &&
    target.primaryChannelId === ref.mainChannelId &&
    (directTarget || channelTarget)
  );
}

function isAuthoritativeDirectTarget(
  route: ReturnType<typeof parseMattermostSessionRoute>,
  identity: AgentIdentity,
  target: AuthorizedConversationTarget,
): boolean {
  const expectedMembers = target.expectedMemberIds ?? [];
  return target.expectedChannelType === "D"
    && route?.peerKind === "direct"
    && expectedMembers.length === 2
    && expectedMembers.includes(identity.coachMmUserId)
    && expectedMembers.includes(route.primaryChannelId);
}

function isAuthoritativePrivateTarget(
  route: ReturnType<typeof parseMattermostSessionRoute>,
  target: AuthorizedConversationTarget,
): boolean {
  return target.expectedChannelType === "P"
    && route?.peerKind !== "direct"
    && target.expectedMemberIds === undefined
    && nonBlank(target.expectedChannelTeamId ?? undefined)
    && nonBlank(target.expectedChannelName ?? undefined);
}

export function createActivityBindingRegistry(
  deps: ActivityBindingRegistryDeps,
): ActivityRuntimeRegistry {
  const bindings = new Map<string, Readonly<ActiveActivityRunBinding>>();
  return {
    readiness: () => "ready",
    async resolve(ref) {
      const existing = bindings.get(ref.runId);
      if (existing) return existing;
      if (!validRoute(ref)) return null;
      const identity = await deps.resolveAgentIdentity(ref.agentId);
      const route = parseMattermostSessionRoute(ref.sessionKey);
      const target = route?.peerKind === "direct"
        ? await deps.resolveDirectConversationTarget(
            ref.agentId,
            ref.conversationId,
            route.primaryChannelId,
          )
        : await deps.resolveConversationTarget(ref.agentId, ref.conversationId);
      if (!identity || !target || !authoritativeTarget(ref, identity, target)) return null;
      const channelCreateAt = await deps.verifyChannel(identity, target);
      const binding = freezeActiveActivityRunBinding({
        conversationId: ref.conversationId,
        turnId: ref.turnId,
        runId: ref.runId,
        ...(ref.parentRunId ? { parentRunId: ref.parentRunId } : {}),
        ...(ref.retryOfRunId ? { retryOfRunId: ref.retryOfRunId } : {}),
        origin: ref.origin,
        agentId: ref.agentId,
        sessionKey: ref.sessionKey,
        mainChannelId: ref.mainChannelId,
        mainRootPostId: ref.mainRootPostId,
        ...(ref.inputPostId ? { inputPostId: ref.inputPostId } : {}),
        channelDocPath: target.channelDocPath,
        channelCreateAt,
        coachToken: identity.coachToken,
        attentionMention: `@${identity.workspaceSlug}`,
      });
      bindings.set(binding.runId, binding);
      return binding;
    },
    async resolveRun(runId) {
      return bindings.get(runId) ?? null;
    },
  };
}
