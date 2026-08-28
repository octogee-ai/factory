import { describe, expect, it } from "vitest";
import type { AgentActivityEnvelopeV1 } from "@octogee/shared/types/agent-conversation";
import {
  activityAttentionPolicy,
  assertCompatibleDeliveryOptions,
} from "../activity-attention-policy.js";

const ref = {
  conversationId: "main-1",
  turnId: "turn-1",
  runId: "run-1",
  agentId: "agent-1",
  sessionKey: "agent:agent-1:mattermost:channel:main-1",
  origin: "human" as const,
  mainChannelId: "main-1",
  mainRootPostId: "turn-1",
  inputPostId: "turn-1",
  itemId: "item-1",
  ordinal: 1,
  semanticVersion: 1,
};

function item(
  kind: Extract<AgentActivityEnvelopeV1, { type: "item.completed" }>['item']['kind'],
  status: Extract<AgentActivityEnvelopeV1, { type: "item.completed" }>['item']['status'],
): AgentActivityEnvelopeV1 {
  return {
    schemaVersion: 1,
    eventKey: "a".repeat(64),
    emittedAt: "2026-07-11T15:00:00.000Z",
    ref: {
      ...ref,
      itemId: kind === "approval" ? "octogee:approval:approval-1" : `item-${kind}`,
    },
    redaction: { policy: "octogee-v1", appliedAt: "producer" },
    type: "item.completed",
    item: { kind, status, summary: `${kind} summary` },
  };
}

describe("activity attention policy", () => {
  it("silences routine Activity creates, including detailed tool failures", () => {
    for (const envelope of [
      item("commentary", "completed"),
      item("tool", "failed"),
    ]) {
      expect(activityAttentionPolicy(envelope)).toMatchObject({
        target: "activity",
        silent: true,
      });
    }
  });

  it("delivers the terminal error notice non-silently", () => {
    expect(activityAttentionPolicy(item("error", "failed"))).toEqual({
      target: "activity",
      silent: false,
      attention: "failure",
    });
  });

  it("delivers waiting approvals normally while keeping resolution edits non-notifying", () => {
    expect(activityAttentionPolicy(item("approval", "waiting"))).toEqual({
      target: "activity",
      silent: false,
      attention: "action-required",
    });

    const transition: AgentActivityEnvelopeV1 = {
      schemaVersion: 1,
      eventKey: "b".repeat(64),
      emittedAt: "2026-07-11T15:01:00.000Z",
      ref: { ...ref, itemId: "octogee:approval:approval-1", semanticVersion: 2 },
      redaction: { policy: "octogee-v1", appliedAt: "producer" },
      type: "control.transition",
      control: { from: "waiting", to: "approved", actorId: "mm-user-1" },
    };
    expect(activityAttentionPolicy(transition)).toEqual({
      target: "activity",
      silent: null,
      attention: "routine",
    });
  });

  it("rejects persistent notification semantics on silent creates", () => {
    expect(() =>
      assertCompatibleDeliveryOptions({ silent: true, persistentNotification: true }),
    ).toThrow("persistent notifications cannot be silent");
    expect(() =>
      assertCompatibleDeliveryOptions({ silent: true, forceNotification: true }),
    ).toThrow("force notification cannot be silent");
  });
});
