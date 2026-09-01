import { describe, expect, it, vi } from "vitest";
import type { AgentActivityIngressRef } from "@octogee/shared/types/agent-conversation";
import { createActivityBindingRegistry } from "../activity-binding-registry.js";

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
    coachMmUserId: "coach-1",
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
  const registry = createActivityBindingRegistry({
    resolveAgentIdentity,
    resolveConversationTarget,
    verifyChannel: vi.fn(async () => 123),
  });
  return { registry, resolveAgentIdentity, resolveConversationTarget };
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
    const { registry, resolveConversationTarget } = harness();
    await expect(registry.resolve({
      ...ref,
      inputPostId: undefined,
      sessionKey: "agent:octogee-alice-coach:mattermost:direct:mm-user-1:thread:root-1",
    })).resolves.toMatchObject({
      runId: "run-1",
      mainChannelId: "channel-1",
      coachToken: "pat-1",
    });
    expect(resolveConversationTarget).toHaveBeenCalledWith(ref.agentId, "channel-1");
  });

  it("rejects a direct session mapped to a physical channel not authorized for the Agent account", async () => {
    const candidate = harness();
    await expect(candidate.registry.resolve({
      ...ref,
      conversationId: "foreign-channel",
      mainChannelId: "foreign-channel",
      inputPostId: undefined,
      sessionKey: "agent:octogee-alice-coach:mattermost:direct:mm-user-1:thread:root-1",
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

  it("accepts the canonical subagent route without inventing unavailable parent lineage", async () => {
    const { registry } = harness();
    await expect(registry.resolve({
      ...ref,
      runId: "child-1",
      origin: "subagent",
      sessionKey: "agent:octogee-alice-coach:subagent:child-1",
    })).resolves.toMatchObject({ runId: "child-1", origin: "subagent" });
  });
});
