import { describe, expect, it, vi } from "vitest";
import type { AgentActivityIngressRef } from "@octogee/shared/types/agent-conversation";
import {
  createActivityBindingRegistry,
  readMattermostChannelCreateAt,
} from "../activity-binding-registry.js";

const AGENT_MM_USER_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_MM_USER_ID = "oooooooooooooooooooooooooo";

const ref: AgentActivityIngressRef = {
  conversationId: "channel-1",
  turnId: "root-1",
  runId: "run-1",
  origin: "human",
  agentId: "octogee-alice-coach",
  sessionKey: "agent:octogee-alice-coach:mattermost:channel:channel-1:thread:root-1",
  mainChannelId: "channel-1",
  mainRootPostId: "root-1",
  inputPostId: "root-1",
  itemId: "item-1",
  ordinal: 1,
  semanticVersion: 1,
};

function harness() {
  const resolveAgentIdentity = vi.fn(async () => ({
    agentId: ref.agentId,
    uid: "uid-1",
    coachMmUserId: AGENT_MM_USER_ID,
    coachToken: "pat-1",
    workspaceSlug: "alice",
    projectSlug: "",
  }));
  const resolveConversationTarget = vi.fn(async () => ({
    primaryChannelId: "channel-1",
    channelDocPath: "workspaces/alice/channels/coach-dm",
    expectedChannelTeamId: "team-1",
    expectedChannelName: "alice-coach",
    expectedChannelType: "P" as const,
  }));
  const resolveDirectConversationTarget = vi.fn(async () => ({
    primaryChannelId: "channel-1",
    channelDocPath: "workspaces/alice/channels/coach-dm",
    expectedChannelTeamId: null,
    expectedChannelName: null,
    expectedChannelType: "D" as const,
    expectedMemberIds: [AGENT_MM_USER_ID, OWNER_MM_USER_ID],
  }));
  const registry = createActivityBindingRegistry({
    resolveAgentIdentity,
    resolveConversationTarget,
    resolveDirectConversationTarget,
    verifyChannel: vi.fn(async () => 123),
  });
  return { registry, resolveAgentIdentity, resolveConversationTarget, resolveDirectConversationTarget };
}

describe("same-channel Activity binding registry", () => {
  it("resolves a canonical Mattermost run against authoritative identity and channel data", async () => {
    const { registry } = harness();

    await expect(registry.resolve({
      ...ref,
      inputPostId: undefined,
    })).resolves.toMatchObject({
      runId: "run-1",
      mainChannelId: "channel-1",
      coachToken: "pat-1",
    });
  });

  it("rejects an unthreaded Mattermost session even when an input post is supplied", async () => {
    const candidate = harness();
    await expect(candidate.registry.resolve({
      ...ref,
      sessionKey: "agent:octogee-alice-coach:mattermost:channel:channel-1",
    })).resolves.toBeNull();
    expect(candidate.resolveAgentIdentity).not.toHaveBeenCalled();
  });

  it("resolves a direct session peer to the exact authorized physical Mattermost channel", async () => {
    const { registry, resolveConversationTarget, resolveDirectConversationTarget } = harness();
    await expect(registry.resolve({
      ...ref,
      inputPostId: undefined,
      sessionKey: `agent:octogee-alice-coach:mattermost:direct:${OWNER_MM_USER_ID}:thread:root-1`,
    })).resolves.toMatchObject({
      runId: "run-1",
      mainChannelId: "channel-1",
      coachToken: "pat-1",
    });
    expect(resolveConversationTarget).not.toHaveBeenCalled();
    expect(resolveDirectConversationTarget).toHaveBeenCalledWith(
      ref.agentId,
      "channel-1",
      OWNER_MM_USER_ID,
    );
  });

  it("rejects a direct session mapped to a physical channel not authorized for the Agent account", async () => {
    const candidate = harness();
    await expect(candidate.registry.resolve({
      ...ref,
      conversationId: "foreign-channel",
      mainChannelId: "foreign-channel",
      inputPostId: undefined,
      sessionKey: `agent:octogee-alice-coach:mattermost:direct:${OWNER_MM_USER_ID}:thread:root-1`,
    })).resolves.toBeNull();
  });

  it("rejects a cross-channel session route", async () => {
    const crossed = harness();
    await expect(crossed.registry.resolve({
      ...ref,
      sessionKey: "agent:octogee-alice-coach:mattermost:channel:foreign:thread:root-1",
    })).resolves.toBeNull();
    expect(crossed.resolveAgentIdentity).not.toHaveBeenCalled();
  });

  it("accepts the canonical subagent route with exact native parent lineage", async () => {
    const { registry } = harness();
    await expect(registry.resolve({
      ...ref,
      runId: "child-1",
      parentRunId: "parent-1",
      origin: "subagent",
      sessionKey: "agent:octogee-alice-coach:subagent:child-1",
    })).resolves.toMatchObject({
      runId: "child-1",
      parentRunId: "parent-1",
      origin: "subagent",
    });
  });

  it("rejects subagent routes without a distinct exact parent run", async () => {
    const missing = harness();
    await expect(missing.registry.resolve({
      ...ref,
      runId: "child-1",
      origin: "subagent",
      sessionKey: "agent:octogee-alice-coach:subagent:child-1",
    })).resolves.toBeNull();
    expect(missing.resolveAgentIdentity).not.toHaveBeenCalled();

    const self = harness();
    await expect(self.registry.resolve({
      ...ref,
      runId: "child-1",
      parentRunId: "child-1",
      origin: "subagent",
      sessionKey: "agent:octogee-alice-coach:subagent:child-1",
    })).resolves.toBeNull();
    expect(self.resolveAgentIdentity).not.toHaveBeenCalled();
  });

  it("resolves a DM-launched subagent through its exact native requester route", async () => {
    const { registry, resolveConversationTarget, resolveDirectConversationTarget } = harness();
    const requesterSessionKey =
      `agent:${ref.agentId}:mattermost:direct:${OWNER_MM_USER_ID}:thread:root-1`;
    const childRef = {
      ...ref,
      runId: "direct-child-1",
      parentRunId: "direct-parent-1",
      origin: "subagent" as const,
      sessionKey: `agent:${ref.agentId}:subagent:child-1`,
      requesterSessionKey,
    };

    await expect(registry.resolve(childRef)).resolves.toMatchObject({
      runId: "direct-child-1",
      sessionKey: childRef.sessionKey,
      requesterSessionKey,
      mainChannelId: "channel-1",
    });
    expect(resolveConversationTarget).not.toHaveBeenCalled();
    expect(resolveDirectConversationTarget).toHaveBeenCalledWith(
      ref.agentId,
      "channel-1",
      OWNER_MM_USER_ID,
    );
  });

  it("rejects requester routing on a non-subagent run", async () => {
    const candidate = harness();
    await expect(candidate.registry.resolve({
      ...ref,
      requesterSessionKey:
        `agent:${ref.agentId}:mattermost:direct:${OWNER_MM_USER_ID}:thread:root-1`,
    })).resolves.toBeNull();
    expect(candidate.resolveAgentIdentity).not.toHaveBeenCalled();
  });

  it("verifies the exact Agent-owner roster for a direct Mattermost channel", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/members?per_page=200")) {
        return new Response(JSON.stringify([
          { user_id: OWNER_MM_USER_ID },
          { user_id: AGENT_MM_USER_ID },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: "channel-1",
        team_id: "",
        name: `${AGENT_MM_USER_ID}__${OWNER_MM_USER_ID}`,
        type: "D",
        create_at: 123,
      }), { status: 200 });
    });

    await expect(readMattermostChannelCreateAt({
      baseUrl: "https://mattermost.test",
      channelId: "channel-1",
      token: "coach-pat",
      expectedTeamId: "",
      expectedName: `${AGENT_MM_USER_ID}__${OWNER_MM_USER_ID}`,
      expectedType: "D",
      expectedMemberIds: [AGENT_MM_USER_ID, OWNER_MM_USER_ID],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toBe(123);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects an extra member in a direct Mattermost channel", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/members?per_page=200")
      ? new Response(JSON.stringify([
          { user_id: OWNER_MM_USER_ID },
          { user_id: AGENT_MM_USER_ID },
          { user_id: "xxxxxxxxxxxxxxxxxxxxxxxxxx" },
        ]), { status: 200 })
      : new Response(JSON.stringify({
          id: "channel-1",
          team_id: "",
          name: `${AGENT_MM_USER_ID}__${OWNER_MM_USER_ID}`,
          type: "D",
          create_at: 123,
        }), { status: 200 }));

    await expect(readMattermostChannelCreateAt({
      baseUrl: "https://mattermost.test",
      channelId: "channel-1",
      token: "coach-pat",
      expectedTeamId: "",
      expectedName: `${AGENT_MM_USER_ID}__${OWNER_MM_USER_ID}`,
      expectedType: "D",
      expectedMemberIds: [AGENT_MM_USER_ID, OWNER_MM_USER_ID],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow("roster does not match Agent and owner");
  });
});
