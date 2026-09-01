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
  ActivitySinkInvalidAttachmentError,
  ActivitySinkIntegrityError,
} from "../activity-sink.js";
import {
  InMemoryActivityWriteReceiptStore,
  type ActivityWriteReceiptStore,
} from "../activity-write-receipts.js";
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
    getPost: vi.fn(async (postId) => ({ id: postId, channelId: "main-1", rootId: "", props: {}, fileIds: [] })),
    listChannelPosts: vi.fn(async () => ({ posts: [], reachedEnd: true })),
    createUploadSession: vi.fn(async () => ({ id: "upload-1", fileOffset: 0 })),
    getUploadSession: vi.fn(async () => ({ id: "upload-1", fileOffset: 0 })),
    uploadData: vi.fn(async () => ({ outcome: "complete", fileId: "file-1" })),
    getFileInfo: vi.fn(async (fileId) => ({ id: fileId, size: 8 })),
    getPostFiles: vi.fn(async () => [{ id: "file-1", size: 8 }]),
  };
}

const binding = {
  mainChannelId: "main-1",
  channelCreateAt: 100,
  attentionMention: "@builder",
};

function journalProps(
  value: AgentActivityEnvelopeV1,
  rootId?: string,
): Record<string, unknown> {
  return {
    octogee: {
      eventKey: value.eventKey,
      runId: value.ref.runId,
      itemId: value.ref.itemId,
      ...(rootId ? { activityRootPostId: rootId } : {}),
    },
  };
}

describe("attention-aware Activity sink", () => {
  it("writes waiting approvals as ordinary native Mattermost posts", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    await sink.append({ envelope: envelope("turn.started"), binding });
    vi.mocked(mm.createActivityPost).mockResolvedValueOnce({ id: "approval-post-1" });
    const approval = envelope("item.completed", {
      item: { kind: "approval", status: "waiting", summary: "Approve deployment?" },
    });
    approval.ref.itemId = "octogee:approval:approval-1";
    approval.eventKey = createHash("sha256")
      .update(agentActivityCanonicalKey(approval.ref))
      .digest("hex");

    const result = await sink.append({ envelope: approval, binding });

    expect(mm.createActivityPost).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "main-1",
      rootId: "turn-1",
      message: "@builder Approve deployment?",
      silent: false,
      props: {
        octogee: expect.objectContaining({
          kind: "activity.approval",
          attention: "action-required",
          eventKey: approval.eventKey,
        }),
      },
    }));
    expect(mm.createActivityPost).toHaveBeenCalledWith(expect.not.objectContaining({
      props: expect.objectContaining({
        attachments: expect.anything(),
      }),
    }));
    expect(result).toMatchObject({
      outcome: "persisted",
      postIds: ["approval-post-1"],
      receipt: {
        eventKey: approval.eventKey,
        postId: "approval-post-1",
        activityRootPostId: "turn-1",
      },
    });
  });

  it("adopts the existing primary turn root and writes journal detail beneath it", async () => {
    const mm = mmClient();
    vi.mocked(mm.getPost).mockResolvedValue({
      id: "turn-1",
      channelId: "main-1",
      rootId: "",
      props: {},
      fileIds: [],
    });
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    const started = envelope("turn.started");

    await expect(sink.append({ envelope: started, binding: binding })).resolves.toMatchObject({
      outcome: "persisted",
      postIds: [],
      receipt: {
        postId: "turn-1",
        activityRootPostId: "turn-1",
      },
    });
    await expect(sink.append({ envelope: started, binding: binding })).resolves.toMatchObject({
      outcome: "duplicate",
      postIds: [],
    });
    expect(mm.listChannelPosts).not.toHaveBeenCalled();
    await sink.append({ envelope: envelope("item.completed"), binding: binding });

    expect(mm.createActivityPost).toHaveBeenCalledTimes(1);
    expect(mm.getPost).toHaveBeenCalledTimes(2);
    expect(mm.createActivityPost).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "main-1",
      rootId: "turn-1",
      silent: true,
    }));
  });

  it("posts the terminal error once beneath the primary turn root without silencing it", async () => {
    const mm = mmClient();
    vi.mocked(mm.getPost).mockResolvedValue({
      id: "turn-1",
      channelId: "main-1",
      rootId: "",
      props: {},
      fileIds: [],
    });
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    await sink.append({ envelope: envelope("turn.started"), binding: binding });
    const terminalError = envelope("item.completed", {
      item: { kind: "error", status: "failed", summary: "Agent run failed" },
    });
    terminalError.ref.itemId = "octogee:terminal-error";
    terminalError.eventKey = createHash("sha256")
      .update(agentActivityCanonicalKey(terminalError.ref))
      .digest("hex");

    await sink.append({ envelope: terminalError, binding: binding });
    await sink.append({ envelope: terminalError, binding: binding });

    expect(mm.createActivityPost).toHaveBeenCalledTimes(1);
    expect(mm.createActivityPost).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "main-1",
      rootId: "turn-1",
      message: "Agent run failed",
      silent: false,
    }));
  });

  it("recovers an adopted root after verification and before receipt commit", async () => {
    const mm = mmClient();
    const delegate = new InMemoryActivityWriteReceiptStore();
    let crashCommit = true;
    const receipts: ActivityWriteReceiptStore = {
      claim: (input) => delegate.claim(input),
      read: (eventKey) => delegate.read(eventKey),
      markPosted: (eventKey, token, postId, now) => delegate.markPosted(eventKey, token, postId, now),
      updateAttachment: (eventKey, token, attachment, now) =>
        delegate.updateAttachment(eventKey, token, attachment, now),
      async commit(eventKey, token, now) {
        if (crashCommit) throw new Error("crashed before adopted root commit");
        await delegate.commit(eventKey, token, now);
      },
    };
    const started = envelope("turn.started");
    vi.mocked(mm.getPost).mockResolvedValue({
      id: "turn-1",
      channelId: "main-1",
      rootId: "",
      props: {},
      fileIds: [],
    });
    const first = createActivitySink({ mm, receipts, leaseOwner: "worker-1", now: () => 0, leaseMs: 1 });

    await expect(first.append({ envelope: started, binding: binding })).rejects.toThrow(
      "crashed before adopted root commit",
    );
    await expect(delegate.read(started.eventKey)).resolves.toMatchObject({
      state: "posted",
      postId: "turn-1",
    });
    crashCommit = false;
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10, leaseMs: 1 });

    await expect(sink.append({ envelope: started, binding: binding })).resolves.toMatchObject({
      outcome: "duplicate",
      postIds: [],
    });
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });

  it.each([
    ["deleted", null],
    ["wrong-channel", { id: "turn-1", channelId: "foreign-channel", rootId: "", props: {}, fileIds: [] }],
    ["thread-reply", { id: "turn-1", channelId: "main-1", rootId: "parent-1", props: {}, fileIds: [] }],
  ])("rejects a %s adopted root before writing a receipt", async (_case, root) => {
    const mm = mmClient();
    vi.mocked(mm.getPost).mockResolvedValue(root);
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
    });

    await expect(sink.append({ envelope: envelope("turn.started"), binding: binding }))
      .rejects.toBeInstanceOf(ActivitySinkIntegrityError);
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });

  it("fails a committed adopted-root replay after its Mattermost root is deleted", async () => {
    const mm = mmClient();
    let root: Awaited<ReturnType<ActivityMattermostClient["getPost"]>> = {
      id: "turn-1",
      channelId: "main-1",
      rootId: "",
      props: {},
      fileIds: [],
    };
    vi.mocked(mm.getPost).mockImplementation(async () => root);
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
    });
    const started = envelope("turn.started");
    await sink.append({ envelope: started, binding: binding });
    root = null;

    await expect(sink.append({ envelope: started, binding: binding }))
      .rejects.toBeInstanceOf(ActivitySinkIntegrityError);
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });

  it("replays a crash after Mattermost create by scanning exactly to the stored anchor", async () => {
    const mm = mmClient();
    const receipts = new InMemoryActivityWriteReceiptStore();
    await createActivitySink({ mm, receipts, leaseOwner: "root-worker", now: () => 0 })
      .append({ envelope: envelope("turn.started"), binding });
    const completed = envelope("item.completed");
    const payloadDigest = activityPayloadDigest(completed);
    const claim = await receipts.claim({
      eventKey: completed.eventKey,
      payloadDigest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "crashed-worker",
      now: 0,
      leaseMs: 1,
    });
    if (claim.outcome !== "claimed") throw new Error("expected claim");
    vi.mocked(mm.listChannelPosts)
      .mockResolvedValueOnce({
        posts: [{ id: "created-before-crash", channelId: "main-1", rootId: "turn-1", props: journalProps(completed, "turn-1"), fileIds: [] }],
        reachedEnd: false,
        nextBefore: "created-before-crash",
      })
      .mockResolvedValueOnce({
        posts: [{ id: "anchor-1", channelId: "main-1", rootId: "", props: {}, fileIds: [] }],
        reachedEnd: false,
        nextBefore: "anchor-1",
      });
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10 });

    const result = await sink.append({ envelope: completed, binding });

    expect(result).toMatchObject({ outcome: "duplicate", postIds: ["created-before-crash"] });
    expect(mm.createActivityPost).not.toHaveBeenCalled();
    expect(mm.listChannelPosts).toHaveBeenCalledTimes(1);
  });

  it("fails visibly when a recovery scan cannot find its stored anchor", async () => {
    const mm = mmClient();
    const receipts = new InMemoryActivityWriteReceiptStore();
    await createActivitySink({ mm, receipts, leaseOwner: "root-worker", now: () => 0 })
      .append({ envelope: envelope("turn.started"), binding });
    const completed = envelope("item.completed");
    await receipts.claim({
      eventKey: completed.eventKey,
      payloadDigest: activityPayloadDigest(completed),
      historyAnchorPostId: "deleted-anchor",
      leaseOwner: "crashed-worker",
      now: 0,
      leaseMs: 1,
    });
    vi.mocked(mm.listChannelPosts).mockResolvedValue({ posts: [], reachedEnd: true });
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10 });

    await expect(sink.append({ envelope: completed, binding })).rejects.toBeInstanceOf(
      ActivitySinkIntegrityError,
    );
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });

  it("pages backward without a cap until the stored anchor, then safely creates", async () => {
    const mm = mmClient();
    const receipts = new InMemoryActivityWriteReceiptStore();
    await createActivitySink({ mm, receipts, leaseOwner: "root-worker", now: () => 0 })
      .append({ envelope: envelope("turn.started"), binding });
    const completed = envelope("item.completed");
    await receipts.claim({
      eventKey: completed.eventKey,
      payloadDigest: activityPayloadDigest(completed),
      historyAnchorPostId: "anchor-1",
      leaseOwner: "crashed-worker",
      now: 0,
      leaseMs: 1,
    });
    vi.mocked(mm.listChannelPosts)
      .mockResolvedValueOnce({
        posts: [{ id: "newer-2", channelId: "main-1", rootId: "", props: {}, fileIds: [] }],
        reachedEnd: false,
        nextBefore: "newer-2",
      })
      .mockResolvedValueOnce({
        posts: [{ id: "newer-1", channelId: "main-1", rootId: "", props: {}, fileIds: [] }],
        reachedEnd: false,
        nextBefore: "newer-1",
      })
      .mockResolvedValueOnce({
        posts: [{ id: "anchor-1", channelId: "main-1", rootId: "", props: {}, fileIds: [] }],
        reachedEnd: false,
        nextBefore: "anchor-1",
      });
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10 });

    const result = await sink.append({ envelope: completed, binding });

    expect(result.outcome).toBe("persisted");
    expect(mm.listChannelPosts).toHaveBeenCalledTimes(3);
    expect(mm.createActivityPost).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["foreign-activity", "", "foreign-post"],
    ["main-1", "foreign-root", "foreign-post"],
    ["main-1", "", "different-returned-post"],
  ])("rejects a recovered receipt post outside its exact channel/root/id (%s, %s, %s)", async (
    channelId,
    rootId,
    returnedPostId,
  ) => {
    const mm = mmClient();
    const receipts = new InMemoryActivityWriteReceiptStore();
    const started = envelope("turn.started");
    const claim = await receipts.claim({
      eventKey: started.eventKey,
      payloadDigest: activityPayloadDigest(started),
      historyAnchorPostId: "anchor-1",
      leaseOwner: "crashed-worker",
      now: 0,
      leaseMs: 1,
    });
    if (claim.outcome !== "claimed") throw new Error("expected claim");
    await receipts.markPosted(started.eventKey, claim.receipt.leaseToken, "foreign-post", 0);
    vi.mocked(mm.getPost).mockResolvedValue({
      id: returnedPostId,
      channelId,
      rootId,
      props: journalProps(started),
      fileIds: [],
    });
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10 });

    await expect(sink.append({ envelope: started, binding })).rejects.toBeInstanceOf(
      ActivitySinkIntegrityError,
    );
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

  it.each(["session-created", "uploading"] as const)(
    "resumes from a durable %s upload receipt without creating a second session",
    async (state) => {
      const mm = mmClient();
      const receipts = new InMemoryActivityWriteReceiptStore();
      const initial = createActivitySink({ mm, receipts, leaseOwner: "worker-1", now: () => 0, leaseMs: 1 });
      await initial.append({ envelope: envelope("turn.started"), binding });
      const bytes = Buffer.from("12345678");
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
      const claim = await receipts.claim({
        eventKey: completed.eventKey,
        payloadDigest: activityPayloadDigest(completed, bytes),
        historyAnchorPostId: "anchor-1",
        leaseOwner: "crashed-worker",
        now: 0,
        leaseMs: 1,
      });
      if (claim.outcome !== "claimed") throw new Error("expected claim");
      await receipts.updateAttachment(completed.eventKey, claim.receipt.leaseToken, {
        state,
        uploadId: "upload-1",
        fileOffset: state === "session-created" ? 0 : 2,
        filename: "tool.txt",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
      }, 0);
      vi.mocked(mm.getUploadSession).mockResolvedValue({ id: "upload-1", fileOffset: 4 });
      vi.mocked(mm.uploadData).mockResolvedValue({ outcome: "complete", fileId: "file-1" });
      vi.mocked(mm.getFileInfo).mockResolvedValue({ id: "file-1", size: 8 });
      vi.mocked(mm.getPostFiles).mockResolvedValue([{ id: "file-1", size: 8 }]);
      vi.mocked(mm.listChannelPosts).mockResolvedValue({
        posts: [{ id: "anchor-1", channelId: "main-1", rootId: "", props: {}, fileIds: [] }],
        reachedEnd: false,
        nextBefore: "anchor-1",
      });
      const recovered = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10 });

      await recovered.append({ envelope: completed, attachment: bytes, binding });

      expect(mm.createUploadSession).not.toHaveBeenCalled();
      const uploaded = vi.mocked(mm.uploadData).mock.calls[0][1];
      expect(Buffer.from(uploaded).toString("utf8")).toBe("5678");
    },
  );

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

  it("re-runs redaction over a bounded attachment source before any Mattermost upload", async () => {
    const mm = mmClient();
    vi.mocked(mm.uploadData).mockRejectedValueOnce(new Error("lost final response"));
    vi.mocked(mm.getUploadSession).mockResolvedValueOnce(null);
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    await sink.append({ envelope: envelope("turn.started"), binding });
    const bytes = new TextEncoder().encode(
      `tool output Bearer secret-token-${"1".repeat(80)} trailing text`,
    );
    const readLengths: number[] = [];
    const source = {
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      async read(offset: number, length: number) {
        readLengths.push(length);
        return bytes.slice(offset, Math.min(offset + length, bytes.byteLength));
      },
    };
    const completed = envelope("item.completed", {
      item: {
        kind: "tool",
        status: "completed",
        summary: "Large output",
        attachment: {
          filename: "tool.txt",
          mediaType: "text/plain",
          byteLength: source.byteLength,
          sha256: source.sha256,
          multipartField: "detail",
        },
      },
    });

    await sink.append({ envelope: completed, attachment: source, binding });

    const uploadedBytes = vi.mocked(mm.uploadData).mock.calls[0][1];
    expect(new TextDecoder().decode(uploadedBytes)).toBe(
      "[redacted: attachment contained secret material]",
    );
    expect(Math.max(...readLengths)).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(mm.createActivityPost).toHaveBeenLastCalledWith(expect.objectContaining({
      message: expect.not.stringContaining("secret-token"),
    }));
  });

  it("rejects invalid UTF-8 attachment detail deterministically before upload", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    await sink.append({ envelope: envelope("turn.started"), binding });
    const bytes = Uint8Array.from([0xc3, 0x28]);
    const completed = envelope("item.completed", {
      item: {
        kind: "tool",
        status: "completed",
        summary: "Invalid detail",
        attachment: {
          filename: "tool.txt",
          mediaType: "text/plain",
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          multipartField: "detail",
        },
      },
    });

    await expect(sink.append({ envelope: completed, attachment: bytes, binding }))
      .rejects.toBeInstanceOf(ActivitySinkInvalidAttachmentError);
    expect(mm.createUploadSession).not.toHaveBeenCalled();
  });

  it("continues UTF-8 validation after detecting a secret and still rejects malformed trailing bytes", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    await sink.append({ envelope: envelope("turn.started"), binding });
    const prefix = new TextEncoder().encode("Bearer secret-token-12345678901234567890 trailing");
    const bytes = Uint8Array.from([...prefix, 0xc3, 0x28]);
    const source = {
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      async read(offset: number) {
        return bytes.slice(offset, Math.min(offset + 8, bytes.byteLength));
      },
    };
    const completed = envelope("item.completed", {
      item: {
        kind: "tool",
        status: "completed",
        summary: "Invalid secret detail",
        attachment: {
          filename: "tool.txt",
          mediaType: "text/plain",
          byteLength: bytes.byteLength,
          sha256: source.sha256,
          multipartField: "detail",
        },
      },
    });

    await expect(sink.append({ envelope: completed, attachment: source, binding }))
      .rejects.toBeInstanceOf(ActivitySinkInvalidAttachmentError);
    expect(mm.createUploadSession).not.toHaveBeenCalled();
  });

  it("recovers a crash after post attachment without another post or physical upload", async () => {
    const mm = mmClient();
    const delegate = new InMemoryActivityWriteReceiptStore();
    let crashCommit = false;
    const receipts: ActivityWriteReceiptStore = {
      claim: (input) => delegate.claim(input),
      read: (eventKey) => delegate.read(eventKey),
      markPosted: (eventKey, token, postId, now) => delegate.markPosted(eventKey, token, postId, now),
      updateAttachment: (eventKey, token, attachment, now) =>
        delegate.updateAttachment(eventKey, token, attachment, now),
      async commit(eventKey, token, now) {
        if (crashCommit) {
          crashCommit = false;
          throw new Error("process crashed before commit");
        }
        await delegate.commit(eventKey, token, now);
      },
    };
    const bytes = Buffer.from("12345678");
    vi.mocked(mm.getFileInfo).mockResolvedValue({ id: "file-1", size: 8 });
    vi.mocked(mm.getPostFiles).mockResolvedValue([{ id: "file-1", size: 8 }]);
    const first = createActivitySink({ mm, receipts, leaseOwner: "worker-1", now: () => 0, leaseMs: 1 });
    await first.append({ envelope: envelope("turn.started"), binding });
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
    crashCommit = true;
    await expect(first.append({ envelope: completed, attachment: bytes, binding })).rejects.toThrow(
      "process crashed before commit",
    );
    const posted = await delegate.read(completed.eventKey);
    if (!posted?.postId) throw new Error("expected posted receipt");
    vi.mocked(mm.getPost).mockResolvedValue({
      id: posted.postId,
      channelId: "main-1",
      rootId: "turn-1",
      props: journalProps(completed, "turn-1"),
      fileIds: ["file-1"],
    });
    const recovered = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10, leaseMs: 1 });

    const result = await recovered.append({ envelope: completed, attachment: bytes, binding });

    expect(result).toMatchObject({ outcome: "duplicate", postIds: [posted.postId] });
    expect(mm.createUploadSession).toHaveBeenCalledTimes(1);
    expect(mm.uploadData).toHaveBeenCalledTimes(1);
    expect(mm.createActivityPost).toHaveBeenCalledTimes(1);
  });

  it("finalization commits an empty post list and never duplicates the final answer", async () => {
    const mm = mmClient();
    const sink = createActivitySink({ mm, receipts: new InMemoryActivityWriteReceiptStore(), leaseOwner: "worker-1" });
    await sink.append({ envelope: envelope("turn.started"), binding });
    const result = await sink.append({ envelope: envelope("turn.finalized"), binding });

    expect(result).toMatchObject({ outcome: "persisted", postIds: [] });
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });
});
