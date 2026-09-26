// @ts-expect-error resolved by the OpenClaw runtime
import type { PluginHookToolContext, PluginHookBeforeToolCallResult } from "openclaw/plugin-sdk/types";
// @ts-expect-error resolved by the OpenClaw runtime
import type { PluginApprovalReviewer } from "openclaw/plugin-sdk/approval-runtime";
import { computerContext, type ComputerBrokerOptions, type ComputerContext } from "./computer-client.js";

type ComputerConfig = Pick<ComputerBrokerOptions, "brokerUrl" | "tokenPath">;

function channelOwner(identity: { channel?: string; accountId?: string; senderId?: string } | undefined, facts: ComputerContext): boolean {
  return Boolean(identity && identity.channel === "mattermost" && identity.accountId === facts.agentAccountId &&
    facts.ownerMattermostUserId && identity.senderId === facts.ownerMattermostUserId);
}

function sameComputer(before: ComputerContext, after: ComputerContext): boolean {
  return before.gatewayId === after.gatewayId && before.ownerUid === after.ownerUid &&
    before.vmInstanceId === after.vmInstanceId && before.agentAccountId === after.agentAccountId &&
    before.ownerMattermostUserId === after.ownerMattermostUserId;
}

function requesterAuthority(context: PluginHookToolContext, facts: ComputerContext, signal: AbortSignal) {
  const requester = context.requester;
  const browserIdentity = requester?.getAuthenticatedIdentity?.();
  const channelIdentity = requester?.channel === "mattermost" && requester.accountId === facts.agentAccountId &&
    typeof requester.senderId === "string" && /^[a-z0-9]{26}$/u.test(requester.senderId);
  if (requester?.getAuthenticatedIdentity ? !browserIdentity?.userId : !channelIdentity) {
    throw new Error("Computer control requires a verified requester");
  }
  const assertActive = () => {
    signal.throwIfAborted();
    if (browserIdentity) {
      const current = requester?.getAuthenticatedIdentity?.();
      if (current?.profileId !== browserIdentity.profileId || current?.userId !== browserIdentity.userId) {
        throw new Error("Computer requester authority changed");
      }
    }
  };
  assertActive();
  return {
    isOwner: browserIdentity ? browserIdentity.userId === facts.ownerUid : channelOwner(requester, facts),
    assertActive,
  };
}

export function computerApprovalHook(config: ComputerConfig) {
  return async (event: { toolName: string }, context: PluginHookToolContext): Promise<PluginHookBeforeToolCallResult | undefined> => {
    if (event.toolName !== "computer" && event.toolName !== "browser" && event.toolName !== "nodes") return;
    try {
      if (!context.agentId || !context.runId || !context.abortSignal) throw new Error("Computer control requires an active agent task");
      const options = { ...config, agentId: context.agentId, signal: context.abortSignal };
      const facts = await computerContext(options);
      const { isOwner, assertActive } = requesterAuthority(context, facts, options.signal);
      if (isOwner) return;
      return {
        requireApproval: {
          title: "Allow computer control?",
          description: `Another Builder's agent is requesting a ${event.toolName} action on your gateway computer. This can use a terminal and install software. Approve this action only if you trust the task.`,
          severity: "warning" as const,
          allowedDecisions: ["allow-once", "deny"],
          timeoutMs: 5 * 60_000,
          reviewerGuard: {
            signal: options.signal,
            assertActive,
            async prepare(reviewer: PluginApprovalReviewer) {
              assertActive();
              if (reviewer.userId ? reviewer.userId !== facts.ownerUid : !channelOwner(reviewer.channel, facts)) return null;
              const current = await computerContext(options);
              assertActive();
              if (!sameComputer(facts, current)) throw new Error("Computer owner or VM changed; request approval again");
              return assertActive;
            },
          },
        },
      };
    } catch (error) {
      return { block: true, blockReason: error instanceof Error ? error.message : "Computer authorization failed" };
    }
  };
}
