import { describe, expect, it, vi } from "vitest";
import {
  ActivityReceiptConflictError,
  ActivityReceiptLeaseError,
  ActivityReceiptUnavailableError,
  FirestoreActivityWriteReceiptStore,
  InMemoryActivityWriteReceiptStore,
  receiptDocumentId,
  type ActivityAttachmentReceiptV1,
} from "../activity-write-receipts.js";

const eventKey = "a".repeat(64);
const digest = "b".repeat(64);

function firestoreStoreReturning(data: Record<string, unknown>) {
  return new FirestoreActivityWriteReceiptStore({
    doc: () => ({
      get: async () => ({ exists: true, data: () => data }),
    }),
    runTransaction: vi.fn(),
  } as never, "workspaces/acme/channels/build");
}

describe("Activity write receipts", () => {
  it("freezes the payload digest and returns committed duplicates", async () => {
    const store = new InMemoryActivityWriteReceiptStore();
    const claim = await store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "worker-1",
      now: 100,
      leaseMs: 1_000,
    });
    expect(claim.outcome).toBe("claimed");
    if (claim.outcome !== "claimed") throw new Error("expected claim");

    await store.markPosted(eventKey, claim.receipt.leaseToken, "post-1", 110);
    await store.commit(eventKey, claim.receipt.leaseToken, 120);

    const duplicate = await store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "different-anchor-is-ignored",
      leaseOwner: "worker-2",
      now: 130,
      leaseMs: 1_000,
    });
    expect(duplicate).toMatchObject({
      outcome: "duplicate",
      receipt: { state: "committed", postId: "post-1", historyAnchorPostId: "anchor-1" },
    });

    await expect(store.claim({
      eventKey,
      payloadDigest: "c".repeat(64),
      historyAnchorPostId: "anchor-1",
      leaseOwner: "worker-3",
      now: 140,
      leaseMs: 1_000,
    })).rejects.toBeInstanceOf(ActivityReceiptConflictError);
  });

  it("serializes concurrent replay and permits recovery only after lease expiry", async () => {
    const store = new InMemoryActivityWriteReceiptStore();
    const first = await store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "worker-1",
      now: 1_000,
      leaseMs: 100,
    });
    expect(first.outcome).toBe("claimed");

    await expect(store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "worker-2",
      now: 1_050,
      leaseMs: 100,
    })).rejects.toBeInstanceOf(ActivityReceiptLeaseError);

    const recovered = await store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "ignored",
      leaseOwner: "worker-2",
      now: 1_101,
      leaseMs: 100,
    });
    expect(recovered).toMatchObject({
      outcome: "claimed",
      receipt: { leaseOwner: "worker-2", historyAnchorPostId: "anchor-1" },
    });
  });

  it("persists every resumable attachment state without losing post state", async () => {
    const store = new InMemoryActivityWriteReceiptStore();
    const claim = await store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "worker-1",
      now: 10,
      leaseMs: 1_000,
    });
    if (claim.outcome !== "claimed") throw new Error("expected claim");

    const states: ActivityAttachmentReceiptV1[] = [
      { state: "session-created", uploadId: "upload-1", fileOffset: 0, filename: "tool.txt", sha256: digest, byteLength: 8 },
      { state: "uploading", uploadId: "upload-1", fileOffset: 4, filename: "tool.txt", sha256: digest, byteLength: 8 },
      { state: "uploaded", uploadId: "upload-1", fileId: "file-1", filename: "tool.txt", sha256: digest, byteLength: 8 },
      { state: "attached", fileId: "file-1", sha256: digest, byteLength: 8 },
    ];
    for (const [index, attachment] of states.entries()) {
      await store.updateAttachment(eventKey, claim.receipt.leaseToken, attachment, 20 + index);
    }
    expect(await store.read(eventKey)).toMatchObject({ attachment: states.at(-1) });
  });

  it("uses sha256(eventKey) as the receipt document id", () => {
    expect(receiptDocumentId(eventKey)).toBe(
      "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    );
  });

  it("uses a production transaction beneath the channel doc for claim, post, and commit fencing", async () => {
    const documents = new Map<string, Record<string, unknown>>();
    const writes: string[] = [];
    const db = {
      doc(path: string) {
        return {
          path,
          async get() {
            const value = documents.get(path);
            return { exists: Boolean(value), data: () => value };
          },
        };
      },
      async runTransaction<T>(fn: (transaction: {
        get(ref: { path: string }): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
        set(ref: { path: string }, data: Record<string, unknown>): void;
      }) => Promise<T>): Promise<T> {
        const staged = new Map<string, Record<string, unknown>>();
        const result = await fn({
          async get(ref) {
            const value = documents.get(ref.path);
            return { exists: Boolean(value), data: () => value };
          },
          set(ref, data) {
            staged.set(ref.path, structuredClone(data));
          },
        });
        for (const [path, data] of staged) {
          writes.push(path);
          documents.set(path, data);
        }
        return result;
      },
    };
    const store = new FirestoreActivityWriteReceiptStore(
      db as never,
      "workspaces/acme/channels/build",
    );
    const claim = await store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "pod-1",
      now: 1,
      leaseMs: 100,
    });
    if (claim.outcome !== "claimed") throw new Error("expected claim");
    await store.markPosted(eventKey, claim.receipt.leaseToken, "post-1", 2);
    await store.commit(eventKey, claim.receipt.leaseToken, 3);

    const expectedPath = `workspaces/acme/channels/build/activityWriteReceipts/${receiptDocumentId(eventKey)}`;
    expect(new Set(writes)).toEqual(new Set([expectedPath]));
    expect(await store.read(eventKey)).toMatchObject({
      state: "committed",
      postId: "post-1",
      historyAnchorPostId: "anchor-1",
    });
    await expect(store.claim({
      eventKey,
      payloadDigest: "c".repeat(64),
      historyAnchorPostId: "other",
      leaseOwner: "pod-2",
      now: 4,
      leaseMs: 100,
    })).rejects.toBeInstanceOf(ActivityReceiptConflictError);
  });

  it("rejects every malformed persisted attachment union state", async () => {
    const base = {
      eventKey,
      payloadDigest: digest,
      state: "claimed",
      historyAnchorPostId: "anchor-1",
      leaseOwner: "pod-1",
      leaseToken: "lease-1",
      leaseExpiresAt: 100,
      updatedAt: 1,
    };
    const malformedAttachments = [
      {
        state: "uploading",
        uploadId: "upload-1",
        fileOffset: Number.MAX_SAFE_INTEGER + 1,
        filename: "tool.txt",
        sha256: digest,
        byteLength: 8,
      },
      { state: "none", uploadId: "smuggled-upload" },
      {
        state: "uploaded",
        uploadId: "upload-1",
        fileId: "",
        filename: "tool.txt",
        sha256: digest,
        byteLength: 8,
      },
      {
        state: "upload-result-unknown",
        uploadId: "upload-1",
        filename: "tool.txt",
        sha256: digest,
        byteLength: 8,
        reason: "   ",
      },
    ];

    for (const attachment of malformedAttachments) {
      await expect(firestoreStoreReturning({ ...base, attachment }).read(eventKey))
        .rejects.toBeInstanceOf(ActivityReceiptUnavailableError);
    }
  });

  it("rejects a receipt whose stored event key does not match the requested document", async () => {
    const store = firestoreStoreReturning({
      eventKey: "c".repeat(64),
      payloadDigest: digest,
      state: "committed",
      historyAnchorPostId: "anchor-1",
      leaseOwner: "pod-1",
      leaseToken: "lease-1",
      leaseExpiresAt: 100,
      attachment: { state: "none" },
      updatedAt: 1,
    });

    await expect(store.read(eventKey)).rejects.toBeInstanceOf(ActivityReceiptUnavailableError);
  });
});
