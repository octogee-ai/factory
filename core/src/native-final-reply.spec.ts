import { describe, expect, it, vi } from "vitest";
import { notifyNativeFinalReply } from "./native-final-reply.js";

const channelId = "c".repeat(26);
const postId = "p".repeat(26);
const rootId = "r".repeat(26);
const userDefaultAgentId = "b".repeat(26);
const ownerId = "u".repeat(26);
const agentId = "octogee-alice-coach";
const signal = {
  schemaVersion: 1 as const,
  accountId: "alice-coach",
  sessionKey: `agent:${agentId}:mattermost:group:${channelId}:thread:${rootId}`,
  to: `channel:${channelId}`,
  messageId: postId,
};

function setup() {
  const identity = { agentId, uid: "uid-alice", defaultAgentMmUserId: userDefaultAgentId,
    coachToken: "agent-token", workspaceSlug: "alice", projectSlug: "" };
  const post = { id: postId, channelId, rootId, userId: userDefaultAgentId, message: "Delivered answer",
    fileIds: [] as string[], props: {}, deleteAt: 0 };
  const target = { primaryChannelId: channelId, channelDocPath: "workspaces/alice/channels/coach-dm",
    expectedChannelType: "P" as "P" | "D", expectedChannelName: "alice-coach",
    expectedChannelTeamId: "team", recipientUid: "uid-alice", recipientMmUserId: ownerId, expectedMemberIds: undefined as string[] | undefined };
  const getPost = vi.fn(async () => post);
  const deps = {
    resolveAgentIdentity: vi.fn(async () => identity),
    resolveReplyTarget: vi.fn(async () => target),
    verifyChannel: vi.fn(async () => 1),
    getPost,
    notify: vi.fn(async () => undefined),
  };
  return { identity, post, target, getPost, deps };
}

describe("native final reply notifications", () => {
  it("reads the delivered post with the broker-owned agent token before notifying its channel owner", async () => {
    const h = setup();
    await notifyNativeFinalReply(signal, h.deps);
    expect(h.getPost).toHaveBeenCalledWith(h.identity, postId);
    expect(h.deps.verifyChannel).toHaveBeenCalledWith(h.identity, h.target);
    expect(h.deps.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      postId, message: "Delivered answer",
      channelId, defaultAgentMmUserId: userDefaultAgentId,
    }), "uid-alice");
  });

  it.each(["account", "session", "recipient", "agent", "author", "channel", "thread", "deleted", "target"])(
    "rejects a mismatched %s binding before notification", async mismatch => {
      const h = setup();
      const input = { ...signal };
      if (mismatch === "account") input.accountId = "bob-coach";
      if (mismatch === "session") input.sessionKey = "agent:octogee-bob-coach:main";
      if (mismatch === "recipient") input.to = `channel:${"z".repeat(26)}`;
      if (mismatch === "agent") h.identity.agentId = "octogee-bob-coach";
      if (mismatch === "author") h.post.userId = ownerId;
      if (mismatch === "channel") h.post.channelId = "z".repeat(26);
      if (mismatch === "thread") h.post.rootId = "z".repeat(26);
      if (mismatch === "deleted") h.post.deleteAt = 100;
      if (mismatch === "target") h.target.primaryChannelId = "z".repeat(26);
      await expect(notifyNativeFinalReply(input, h.deps)).rejects.toThrow("reply_binding_denied");
      expect(h.deps.notify).not.toHaveBeenCalled();
    },
  );

  it("accepts a threaded room reply in a native channel-scoped session", async () => {
    const h = setup();
    await notifyNativeFinalReply({ ...signal, sessionKey: `agent:${agentId}:mattermost:group:${channelId}` }, h.deps);
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
  });

  it("rejects a threaded direct reply whose session omits its native thread", async () => {
    const h = setup();
    h.target.expectedChannelType = "D";
    h.target.expectedMemberIds = [ownerId, userDefaultAgentId];
    await expect(notifyNativeFinalReply({ ...signal, to: `user:${ownerId}`,
      sessionKey: `agent:${agentId}:mattermost:direct:${ownerId}`,
    }, h.deps)).rejects.toThrow("reply_binding_denied");
    expect(h.deps.notify).not.toHaveBeenCalled();
  });

  it("resolves a direct recipient through the authoritative owner and exact member roster", async () => {
    const h = setup();
    h.target.expectedChannelType = "D";
    h.target.expectedMemberIds = [ownerId, userDefaultAgentId];
    await notifyNativeFinalReply({ ...signal, to: `user:${ownerId}`,
      sessionKey: `agent:${agentId}:mattermost:direct:${ownerId}:thread:${rootId}`,
    }, h.deps);
    expect(h.deps.resolveReplyTarget).toHaveBeenCalledWith(h.identity, channelId, ownerId);
    expect(h.deps.verifyChannel).toHaveBeenCalledWith(h.identity, h.target);
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
  });

  it("rejects a direct recipient that is absent from the authoritative roster", async () => {
    const h = setup();
    h.target.expectedChannelType = "D";
    h.target.expectedMemberIds = ["z".repeat(26), userDefaultAgentId];
    await expect(notifyNativeFinalReply({ ...signal, to: `user:${ownerId}`,
      sessionKey: `agent:${agentId}:mattermost:direct:${ownerId}:thread:${rootId}`,
    }, h.deps)).rejects.toThrow("reply_binding_denied");
    expect(h.deps.notify).not.toHaveBeenCalled();
  });

  it("notifies an attachment-only final answer using the delivered post", async () => {
    const h = setup();
    h.post.message = "";
    h.post.fileIds = ["file"];
    await notifyNativeFinalReply(signal, h.deps);
    expect(h.deps.notify).toHaveBeenCalledWith(expect.objectContaining({ message: "Sent an attachment" }), "uid-alice");
  });

  it("propagates provider and broker failures so intake does not acknowledge delivery", async () => {
    const h = setup();
    h.getPost.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(notifyNativeFinalReply(signal, h.deps)).rejects.toThrow("provider unavailable");
    h.deps.notify.mockRejectedValueOnce(new Error("broker unavailable"));
    await expect(notifyNativeFinalReply(signal, h.deps)).rejects.toThrow("broker unavailable");
  });
});
