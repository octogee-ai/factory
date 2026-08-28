import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_ACTIVITY_RESERVED_ITEM_IDS,
  agentActivityCanonicalKey,
  type AgentActivityEnvelopeV1,
} from "@octogee/shared/types/agent-conversation";
import {
  ActivityIntakeError,
  MutableActivityRuntimeRegistry,
  parseActivityEnvelope,
  processActivityIntake,
  type ActiveActivityRunBinding,
} from "../activity-intake.js";
import { ActivitySinkInvalidAttachmentError } from "../activity-sink.js";

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

function startedEnvelope(origin: ActiveActivityRunBinding["origin"]): AgentActivityEnvelopeV1 {
  const ref = {
    conversationId: "main-1",
    turnId: "turn-1",
    runId: "run-1",
    agentId: "agent-1",
    sessionKey: "agent:agent-1:mattermost:channel:main-1",
    origin,
    mainChannelId: "main-1",
    mainRootPostId: "turn-1",
    inputPostId: "turn-1",
    itemId: AGENT_ACTIVITY_RESERVED_ITEM_IDS.runRoot,
    ordinal: 0,
    semanticVersion: 1,
  };
  return {
    schemaVersion: 1,
    eventKey: createHash("sha256").update(agentActivityCanonicalKey(ref)).digest("hex"),
    emittedAt: "2026-07-11T15:00:00.000Z",
    ref,
    redaction: { policy: "octogee-v1", appliedAt: "producer" },
    type: "turn.started",
  };
}

const binding = {
  conversationId: "main-1",
  turnId: "turn-1",
  runId: "run-1",
  origin: "human" as const,
  agentId: "agent-1",
  sessionKey: "agent:agent-1:mattermost:channel:main-1",
  mainChannelId: "main-1",
  mainRootPostId: "turn-1",
  inputPostId: "turn-1",
  activityChannelId: "activity-1",
  channelDocPath: "workspaces/acme/channels/build",
  channelCreateAt: 100,
  coachToken: "coach-token",
  attentionMention: "@builder",
};

describe("normalized Activity intake", () => {
  it("parses every exact W1 envelope fixture without widening its v1 union", () => {
    const fixture = JSON.parse(readFileSync(
      path.resolve(__dirname, "../../../../../tests/fixtures/agent-conversation/agent-activity-envelopes.json"),
      "utf8",
    )) as { envelopes: unknown[] };
    expect(fixture.envelopes.map((value) => parseActivityEnvelope(value).type)).toHaveLength(18);
  });

  it("accepts only loopback requests with an exact active runtime binding", async () => {
    const onPersisted = vi.fn();
    const append = vi.fn(async () => ({
      outcome: "persisted" as const,
      postIds: ["post-1"],
      receipt: {
        eventKey: validEnvelope().eventKey,
        postId: "post-1",
        activityChannelId: "activity-1",
        activityRootPostId: "activity-root-1",
        rootOwnership: "sink-created" as const,
      },
    }));
    const envelope = validEnvelope();
    const result = await processActivityIntake(
      { remoteAddress: "::ffff:127.0.0.1", envelope },
      {
        registry: { readiness: () => "ready", resolve: vi.fn(async () => binding) },
        sinkFor: vi.fn(() => ({ append })),
        onPersisted,
      },
    );

    expect(result).toEqual({
      status: 201,
      body: {
        outcome: "persisted",
        postIds: ["post-1"],
        activityChannelId: "activity-1",
        activityRootPostId: "activity-root-1",
      },
    });
    expect(append).toHaveBeenCalledWith({ envelope, binding, attachment: undefined });
    expect(onPersisted).toHaveBeenCalledWith({
      envelope,
      binding,
      activityRootPostId: "activity-root-1",
      outcome: "persisted",
    });
  });

  it("accepts a same-channel turn-start receipt that adopts the input root", async () => {
    const envelope = startedEnvelope("human");
    const sameChannelBinding = { ...binding, activityChannelId: binding.mainChannelId };
    const append = vi.fn(async () => ({
      outcome: "persisted" as const,
      postIds: [],
      receipt: {
        eventKey: envelope.eventKey,
        postId: binding.mainRootPostId,
        activityChannelId: binding.mainChannelId,
        activityRootPostId: binding.mainRootPostId,
        rootOwnership: "adopted" as const,
      },
    }));

    await expect(processActivityIntake(
      { remoteAddress: "127.0.0.1", envelope },
      {
        registry: { readiness: () => "ready", resolve: vi.fn(async () => sameChannelBinding) },
        sinkFor: vi.fn(() => ({ append })),
      },
    )).resolves.toMatchObject({
      status: 201,
      body: {
        postIds: [],
        activityChannelId: binding.mainChannelId,
        activityRootPostId: binding.mainRootPostId,
      },
    });
  });

  it("keeps a durable append successful when its observer fails", async () => {
    const envelope = validEnvelope();
    const log = vi.fn();
    await expect(processActivityIntake(
      { remoteAddress: "127.0.0.1", envelope },
      {
        registry: { readiness: () => "ready", resolve: vi.fn(async () => binding) },
        sinkFor: vi.fn(() => ({
          append: async () => ({
            outcome: "persisted" as const,
            postIds: ["post-1"],
            receipt: {
              eventKey: envelope.eventKey,
              postId: "post-1",
              activityChannelId: "activity-1",
              activityRootPostId: "activity-root-1",
              rootOwnership: "sink-created" as const,
            },
          }),
        })),
        onPersisted: () => {
          throw new Error("observer unavailable");
        },
        log,
      },
    )).resolves.toMatchObject({ status: 201, body: { outcome: "persisted" } });
    expect(log).toHaveBeenCalledWith("activity_intake_observer_failed", {
      eventKey: envelope.eventKey,
      runId: envelope.ref.runId,
      error: "observer unavailable",
    });
  });

  it("returns the same authoritative Activity sibling on a duplicate acknowledgement", async () => {
    const result = await processActivityIntake(
      { remoteAddress: "127.0.0.1", envelope: validEnvelope() },
      {
        registry: { readiness: () => "ready", resolve: vi.fn(async () => binding) },
        sinkFor: vi.fn(() => ({
          append: vi.fn(async () => ({
            outcome: "duplicate" as const,
            postIds: ["post-1"],
            receipt: {
              eventKey: validEnvelope().eventKey,
              postId: "post-1",
              activityChannelId: "activity-1",
              activityRootPostId: "activity-root-1",
              rootOwnership: "sink-created" as const,
            },
          })),
        })),
      },
    );

    expect(result).toEqual({
      status: 200,
      body: {
        outcome: "duplicate",
        postIds: ["post-1"],
        activityChannelId: "activity-1",
        activityRootPostId: "activity-root-1",
      },
    });
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
    ["origin", "scheduled"],
    ["parentRunId", "parent-run-1"],
    ["retryOfRunId", "retry-run-1"],
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

  it("freezes validated snapshot bindings and rejects unsafe integer identity", async () => {
    const registry = new MutableActivityRuntimeRegistry();
    registry.replaceSnapshot([binding]);
    const resolved = await registry.resolve(validEnvelope().ref);
    await expect(registry.resolveRun("run-1")).resolves.toBe(resolved);
    expect(resolved).not.toBeNull();
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(() => {
      (resolved as ActiveActivityRunBinding).mainChannelId = "mutated";
    }).toThrow();

    const unsafe = validEnvelope() as unknown as { ref: Record<string, unknown> };
    unsafe.ref.ordinal = Number.MAX_SAFE_INTEGER + 1;
    expect(() => parseActivityEnvelope(unsafe)).toThrowError(
      expect.objectContaining({ status: 422, code: "invalid_envelope" }),
    );
  });

  it("rejects an unfenced runtime binding with an unsafe create time", async () => {
    await expect(processActivityIntake(
      { remoteAddress: "127.0.0.1", envelope: validEnvelope() },
      {
        registry: {
          readiness: () => "ready",
          resolve: vi.fn(async () => ({ ...binding, channelCreateAt: Number.MAX_SAFE_INTEGER + 1 })),
        },
        sinkFor: vi.fn(),
      },
    )).rejects.toMatchObject({ status: 403, code: "invalid_runtime_binding" });
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

  it.each([
    ["octogee:approval:approval-1", "tool", "completed", 1, "invalid_approval"],
    [AGENT_ACTIVITY_RESERVED_ITEM_IDS.terminalError, "tool", "failed", 1, "invalid_terminal_error"],
    [AGENT_ACTIVITY_RESERVED_ITEM_IDS.terminalError, "error", "completed", 1, "invalid_terminal_error"],
    [AGENT_ACTIVITY_RESERVED_ITEM_IDS.terminalError, "error", "failed", 2, "invalid_terminal_error"],
  ] as const)(
    "rejects reserved item misuse for %s as %s/%s/v%s",
    (itemId, kind, status, semanticVersion, code) => {
      const value = validEnvelope();
      if (value.type !== "item.completed") throw new Error("expected item");
      value.ref.itemId = itemId;
      value.ref.semanticVersion = semanticVersion;
      value.item = { kind, status, summary: "reserved misuse" };
      value.eventKey = createHash("sha256")
        .update(agentActivityCanonicalKey(value.ref))
        .digest("hex");

      expect(() => parseActivityEnvelope(value)).toThrowError(
        expect.objectContaining({ status: 422, code }),
      );
    },
  );

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

  it.each([
    ["../tool.txt", "text/plain"],
    ["tool\n.txt", "text/plain"],
    ["😀".repeat(100), "text/plain"],
    ["tool.txt", "application/octet-stream"],
  ])("rejects unsafe attachment filename/media metadata (%s, %s)", (filename, mediaType) => {
    const envelope = validEnvelope();
    if (envelope.type !== "item.completed") throw new Error("expected item");
    envelope.item.attachment = {
      filename,
      mediaType,
      byteLength: 1,
      sha256: "a".repeat(64),
      multipartField: "detail",
    };
    expect(() => parseActivityEnvelope(envelope)).toThrowError(
      expect.objectContaining({ status: 422, code: "invalid_attachment" }),
    );
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

  it("maps invalid UTF-8 detail to a deterministic non-retryable 422", async () => {
    await expect(processActivityIntake(
      { remoteAddress: "127.0.0.1", envelope: validEnvelope() },
      {
        registry: { readiness: () => "ready", resolve: vi.fn(async () => binding) },
        sinkFor: () => ({
          append: vi.fn(async () => {
            throw new ActivitySinkInvalidAttachmentError("attachment detail is not UTF-8");
          }),
        }),
      },
    )).rejects.toMatchObject({
      status: 422,
      code: "invalid_attachment_encoding",
      retryable: false,
    });
  });
});
