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
  verifyChannel(identity: AgentIdentity, target: AuthorizedConversationTarget): Promise<number>;
}

export async function readMattermostChannelCreateAt(input: {
  baseUrl: string;
  channelId: string;
  token: string;
  expectedTeamId: string;
  expectedName: string;
  expectedType: "P";
  fetchImpl?: typeof fetch;
}): Promise<number> {
  const response = await (input.fetchImpl ?? fetch)(
    `${input.baseUrl.replace(/\/{1,32}$/, "")}/api/v4/channels/${encodeURIComponent(input.channelId)}`,
    { headers: { authorization: `Bearer ${input.token}` } },
  );
  if (!response.ok) {
    throw new Error(`MM channel lookup ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const channel = await response.json() as Record<string, unknown>;
  if (
    channel.id !== input.channelId ||
    channel.team_id !== input.expectedTeamId ||
    channel.name !== input.expectedName ||
    channel.type !== input.expectedType ||
    !Number.isSafeInteger(channel.create_at) ||
    (channel.create_at as number) < 0
  ) {
    throw new Error("MM channel lookup returned an unauthorized binding");
  }
  return channel.create_at as number;
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
  return Boolean(
    route &&
    route.agentId === ref.agentId &&
    route.primaryChannelId === ref.mainChannelId &&
    nonBlank(ref.inputPostId) &&
    (route.threadRootPostId ?? ref.inputPostId) === ref.mainRootPostId,
  );
}

function authoritativeTarget(
  ref: AgentActivityIngressRef,
  identity: AgentIdentity,
  target: AuthorizedConversationTarget,
): boolean {
  return (
    identity.agentId === ref.agentId &&
    nonBlank(identity.coachToken) &&
    nonBlank(identity.workspaceSlug) &&
    target.primaryChannelId === ref.mainChannelId &&
    target.expectedChannelType === "P"
  );
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
      const target = await deps.resolveConversationTarget(ref.agentId, ref.conversationId);
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
