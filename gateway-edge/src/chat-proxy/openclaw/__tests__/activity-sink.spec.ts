import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_ACTIVITY_RESERVED_ITEM_IDS,
  agentActivityCanonicalKey,
  type AgentActivityEnvelopeV1,
} from "@octogee/shared/types/agent-conversation";
import {
  activityPayloadDigest,
  createActivitySink,
  ActivitySinkIntegrityError,
} from "../activity-sink.js";
import { InMemoryActivityWriteReceiptStore } from "../activity-write-receipts.js";
import type { ActivityMattermostClient } from "../mm-client.js";

function envelope(
  type: AgentActivityEnvelopeV1['type'],
  overrides: Partial<AgentActivityEnvelopeV1> = {},
): AgentActivityEnvelopeV1 {
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
    itemId: type === "turn.started" ? AGENT_ACTIVITY_RESERVED_ITEM_IDS.runRoot : "tool-1",
    ordinal: type === "turn.started" ? 0 : 1,
    semanticVersion: 1,
  };
  const base = {
    schemaVersion: 1 as const,
    eventKey: createHash("sha256").update(agentActivityCanonicalKey(ref)).digest("hex"),
    emittedAt: "2026-07-11T15:00:00.000Z",
    ref,
    redaction: { policy: "octogee-v1" as const, appliedAt: "producer" as const },
  };
  if (type === "turn.started") return { ...base, type, ...overrides } as AgentActivityEnvelopeV1;
  if (type === "turn.finalized") {
    const finalizedRef = {
      ...ref,
      itemId: AGENT_ACTIVITY_RESERVED_ITEM_IDS.turnFinalized,
      ordinal: 2,
    };
    return {
      ...base,
      eventKey: createHash("sha256").update(agentActivityCanonicalKey(finalizedRef)).digest("hex"),
      ref: finalizedRef,
      type,
      outcome: "completed",
      ...overrides,
    } as AgentActivityEnvelopeV1;
  }
  return {
    ...base,
    type: "item.completed",
    item: { kind: "tool", status: "completed", summary: "Ran inspection" },
    ...overrides,
  } as AgentActivityEnvelopeV1;
}

function mmClient(): ActivityMattermostClient {
  let next = 0;
  return {
    createPost: vi.fn(async () => ({ id: `post-${++next}` })),
    editPost: vi.fn(async () => undefined),
    deletePost: vi.fn(async () => undefined),
    withUserToken: vi.fn(),
    createActivityPost: vi.fn(async () => ({ id: `post-${++next}` })),
    getPost: vi.fn(async (postId) => ({ id: postId, channelId: "activity-1", rootId: "", props: {}, fileIds: [] })),
    listChannelPosts: vi.fn(async () => ({ posts: [], reachedEnd: true })),
    createUploadSession: vi.fn(async () => ({ id: "upload-1", fileOffset: 0 })),
    getUploadSession: vi.fn(async () => ({ id: "upload-1", fileOffset: 0 })),
    uploadData: vi.fn(async () => ({ outcome: "complete", fileId: "file-1" })),
    getFileInfo: vi.fn(async (fileId) => ({ id: fileId, size: 8 })),
    getPostFiles: vi.fn(async () => [{ id: "file-1", size: 8 }]),
  };
}

const binding = {
  activityChannelId: "activity-1",
  channelCreateAt: 100,
};

describe("attention-aware Activity sink", () => {
  it("creates one silent run root and returns the same post on concurrent replay", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    const started = envelope("turn.started");

    const [first, replay] = await Promise.all([
      sink.append({ envelope: started, binding }),
      sink.append({ envelope: started, binding }),
    ]);

    expect([first.outcome, replay.outcome].sort()).toEqual(["duplicate", "persisted"]);
    expect(mm.createActivityPost).toHaveBeenCalledTimes(1);
    expect(mm.createActivityPost).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "activity-1",
      silent: true,
      rootId: undefined,
      pendingPostId: started.eventKey,
    }));
  });

  it("replays a crash after Mattermost create by scanning exactly to the stored anchor", async () => {
    const mm = mmClient();
    const receipts = new InMemoryActivityWriteReceiptStore();
    const started = envelope("turn.started");
    const payloadDigest = activityPayloadDigest(started);
    const claim = await receipts.claim({
      eventKey: started.eventKey,
      payloadDigest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "crashed-worker",
      now: 0,
      leaseMs: 1,
    });
    if (claim.outcome !== "claimed") throw new Error("expected claim");
    vi.mocked(mm.listChannelPosts)
      .mockResolvedValueOnce({
        posts: [{ id: "created-before-crash", channelId: "activity-1", rootId: "", props: { octogee: { eventKey: started.eventKey } }, fileIds: [] }],
        reachedEnd: false,
        nextBefore: "created-before-crash",
      })
      .mockResolvedValueOnce({
        posts: [{ id: "anchor-1", channelId: "activity-1", rootId: "", props: {}, fileIds: [] }],
        reachedEnd: false,
        nextBefore: "anchor-1",
      });
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10 });

    const result = await sink.append({ envelope: started, binding });

    expect(result).toEqual({ outcome: "duplicate", postIds: ["created-before-crash"] });
    expect(mm.createActivityPost).not.toHaveBeenCalled();
    expect(mm.listChannelPosts).toHaveBeenCalledTimes(1);
  });

  it("fails visibly when a recovery scan cannot find its stored anchor", async () => {
    const mm = mmClient();
    const receipts = new InMemoryActivityWriteReceiptStore();
    const started = envelope("turn.started");
    await receipts.claim({
      eventKey: started.eventKey,
      payloadDigest: activityPayloadDigest(started),
      historyAnchorPostId: "deleted-anchor",
      leaseOwner: "crashed-worker",
      now: 0,
      leaseMs: 1,
    });
    vi.mocked(mm.listChannelPosts).mockResolvedValue({ posts: [], reachedEnd: true });
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10 });

    await expect(sink.append({ envelope: started, binding })).rejects.toBeInstanceOf(
      ActivitySinkIntegrityError,
    );
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });

  it("redacts inline detail again before persistence", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    await sink.append({ envelope: envelope("turn.started"), binding });
    const completed = envelope("item.completed", {
      item: {
        kind: "tool",
        status: "completed",
        summary: "Used sk-proj-1234567890abcdefghijklmnop",
        detail: { format: "text", text: "Bearer secret-token-1234567890" },
      },
    });

    await sink.append({ envelope: completed, binding });

    expect(mm.createActivityPost).toHaveBeenLastCalledWith(expect.objectContaining({
      message: expect.not.stringContaining("secret-token"),
    }));
  });

  it("attaches large detail once and records a lost final response without reuploading", async () => {
    const mm = mmClient();
    vi.mocked(mm.uploadData).mockRejectedValueOnce(new Error("connection reset after final byte"));
    vi.mocked(mm.getUploadSession).mockResolvedValueOnce(null);
    const receipts = new InMemoryActivityWriteReceiptStore();
    const alerts = { attachmentUnknown: vi.fn(), integrityFailure: vi.fn() };
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-1", now: () => 1_000, alerts });
    await sink.append({ envelope: envelope("turn.started"), binding });
    const bytes = Buffer.from("redacted output");
    const completed = envelope("item.completed", {
      item: {
        kind: "tool",
        status: "completed",
        summary: "Large output",
        attachment: {
          filename: "tool.txt",
          mediaType: "text/plain",
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          multipartField: "detail",
        },
      },
    });

    const first = await sink.append({ envelope: completed, attachment: bytes, binding });
    const replay = await sink.append({ envelope: completed, attachment: bytes, binding });

    expect(first.outcome).toBe("persisted");
    expect(replay.outcome).toBe("duplicate");
    expect(mm.createUploadSession).toHaveBeenCalledTimes(1);
    expect(mm.uploadData).toHaveBeenCalledTimes(1);
    expect(alerts.attachmentUnknown).toHaveBeenCalledTimes(1);
    expect(mm.createActivityPost).toHaveBeenLastCalledWith(expect.objectContaining({
      fileIds: undefined,
      message: expect.stringContaining("attachment unavailable"),
    }));
  });

  it("finalization commits an empty post list and never duplicates the final answer", async () => {
    const mm = mmClient();
    const sink = createActivitySink({ mm, receipts: new InMemoryActivityWriteReceiptStore(), leaseOwner: "worker-1" });
    const result = await sink.append({ envelope: envelope("turn.finalized"), binding });

    expect(result).toEqual({ outcome: "persisted", postIds: [] });
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });
});
