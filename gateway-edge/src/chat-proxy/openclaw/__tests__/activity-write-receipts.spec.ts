import { describe, expect, it } from "vitest";
import {
  ActivityReceiptConflictError,
  ActivityReceiptLeaseError,
  InMemoryActivityWriteReceiptStore,
  receiptDocumentId,
  type ActivityAttachmentReceiptV1,
} from "../activity-write-receipts.js";

const eventKey = "a".repeat(64);
const digest = "b".repeat(64);

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
});
