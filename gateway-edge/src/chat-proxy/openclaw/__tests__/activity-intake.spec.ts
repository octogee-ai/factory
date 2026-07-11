import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  agentActivityCanonicalKey,
  type AgentActivityEnvelopeV1,
} from "@octogee/shared/types/agent-conversation";
import {
  ActivityIntakeError,
  parseActivityEnvelope,
  processActivityIntake,
  type ActiveActivityRunBinding,
} from "../activity-intake.js";

function validEnvelope(): AgentActivityEnvelopeV1 {
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
    itemId: "tool-1",
    ordinal: 1,
    semanticVersion: 1,
  };
  return {
    schemaVersion: 1,
    eventKey: createHash("sha256").update(agentActivityCanonicalKey(ref)).digest("hex"),
    emittedAt: "2026-07-11T15:00:00.000Z",
    ref,
    redaction: { policy: "octogee-v1", appliedAt: "producer" },
    type: "item.completed",
    item: { kind: "tool", status: "completed", summary: "Inspected gateway" },
  };
}

const binding: ActiveActivityRunBinding = {
  conversationId: "main-1",
  turnId: "turn-1",
  runId: "run-1",
  agentId: "agent-1",
  sessionKey: "agent:agent-1:mattermost:channel:main-1",
  mainChannelId: "main-1",
  mainRootPostId: "turn-1",
  inputPostId: "turn-1",
  activityChannelId: "activity-1",
  channelDocPath: "workspaces/acme/channels/build",
  channelCreateAt: 100,
  coachToken: "coach-token",
};

describe("normalized Activity intake", () => {
  it("accepts only loopback requests with an exact active runtime binding", async () => {
    const append = vi.fn(async () => ({ outcome: "persisted" as const, postIds: ["post-1"] }));
    const envelope = validEnvelope();
    const result = await processActivityIntake(
      { remoteAddress: "::ffff:127.0.0.1", envelope },
      {
        registry: { readiness: () => "ready", resolve: vi.fn(async () => binding) },
        sinkFor: vi.fn(() => ({ append })),
      },
    );

    expect(result).toEqual({ status: 201, body: { outcome: "persisted", postIds: ["post-1"] } });
    expect(append).toHaveBeenCalledWith({ envelope, binding, attachment: undefined });
  });

  it("returns 401 for non-loopback sockets without consulting the registry", async () => {
    const resolve = vi.fn(async () => binding);
    await expect(processActivityIntake(
      { remoteAddress: "10.0.0.4", envelope: validEnvelope() },
      { registry: { readiness: () => "ready", resolve }, sinkFor: vi.fn() },
    )).rejects.toMatchObject({ status: 401, code: "non_loopback" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["agentId", "other-agent"],
    ["sessionKey", "agent:agent-1:mattermost:channel:other"],
    ["mainChannelId", "main-2"],
    ["mainRootPostId", "turn-2"],
  ] as const)("returns 403 for a cross-binding %s", async (field, value) => {
    const envelope = validEnvelope();
    envelope.ref[field] = value;
    if (field === "mainChannelId") envelope.ref.conversationId = value;
    envelope.eventKey = createHash("sha256")
      .update(agentActivityCanonicalKey(envelope.ref))
      .digest("hex");

    await expect(processActivityIntake(
      { remoteAddress: "127.0.0.1", envelope },
      {
        registry: { readiness: () => "ready", resolve: vi.fn(async () => binding) },
        sinkFor: vi.fn(),
      },
    )).rejects.toMatchObject({ status: 403, code: "binding_mismatch" });
  });

  it("returns retryable 503 before the runtime snapshot is synchronized", async () => {
    await expect(processActivityIntake(
      { remoteAddress: "127.0.0.1", envelope: validEnvelope() },
      {
        registry: { readiness: () => "unsynchronized", resolve: vi.fn() },
        sinkFor: vi.fn(),
      },
    )).rejects.toMatchObject({ status: 503, code: "runtime_unsynchronized" });
  });

  it("rejects schema, redaction, reserved identity, and event-key failures as 422", () => {
    const bad = validEnvelope() as unknown as Record<string, unknown>;
    bad.eventKey = "0".repeat(64);
    expect(() => parseActivityEnvelope(bad)).toThrowError(ActivityIntakeError);
    try {
      parseActivityEnvelope(bad);
      throw new Error("expected parser failure");
    } catch (error) {
      expect(error).toMatchObject({ status: 422, code: "event_key_mismatch" });
    }
  });

  it("validates streamed attachment byte length and sha256 before binding or writes", async () => {
    const envelope = validEnvelope();
    const bytes = Buffer.from("actual bytes");
    if (envelope.type !== "item.completed") throw new Error("expected item");
    envelope.item.attachment = {
      filename: "tool.txt",
      mediaType: "text/plain",
      byteLength: bytes.byteLength + 1,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      multipartField: "detail",
    };
    const resolve = vi.fn(async () => binding);
    await expect(processActivityIntake(
      { remoteAddress: "127.0.0.1", envelope, attachment: bytes },
      { registry: { readiness: () => "ready", resolve }, sinkFor: vi.fn() },
    )).rejects.toMatchObject({ status: 422, code: "attachment_length_mismatch" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("maps digest conflicts to non-retryable 409 and receipt outages to retryable 503", async () => {
    const makeDeps = (error: ActivityIntakeError) => ({
      registry: { readiness: () => "ready" as const, resolve: vi.fn(async () => binding) },
      sinkFor: vi.fn(() => ({ append: vi.fn(async () => { throw error; }) })),
    });
    await expect(processActivityIntake(
      { remoteAddress: "127.0.0.1", envelope: validEnvelope() },
      makeDeps(new ActivityIntakeError(409, "payload_conflict", false)),
    )).rejects.toMatchObject({ status: 409, retryable: false });
    await expect(processActivityIntake(
      { remoteAddress: "127.0.0.1", envelope: validEnvelope() },
      makeDeps(new ActivityIntakeError(503, "receipt_unavailable", true)),
    )).rejects.toMatchObject({ status: 503, retryable: true });
  });
});
