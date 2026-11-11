import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startMmChatActivityListeners,
  type MmChatActivityListenerDeps,
} from "../mm-chat-activity-listener.js";

class FakeWs extends EventEmitter {
  send = vi.fn();
  close(): void {
    this.emit("close");
  }
  message(event: "posted" | "post_edited", post: Record<string, unknown>): void {
    this.emit("message", JSON.stringify({ event, data: { post: JSON.stringify(post) } }));
  }
  reaction(reaction: Record<string, unknown>, broadcastChannelId = "channel-1"): void {
    this.emit("message", JSON.stringify({
      event: "reaction_added",
      data: { reaction: JSON.stringify(reaction) },
      broadcast: { channel_id: broadcastChannelId },
    }));
  }
}

function harness(overrides: Partial<MmChatActivityListenerDeps> = {}) {
  const sockets: FakeWs[] = [];
  const onChatActivity = vi.fn();
  const manager = startMmChatActivityListeners({
    log: vi.fn(),
    openWebSocket: () => {
      const socket = new FakeWs();
      sockets.push(socket);
      return socket as unknown as import("ws").WebSocket;
    },
    onChatActivity,
    backoffSchedule: [10],
    ...overrides,
  });
  manager.addDefaultAgent({ defaultAgentMmUserId: "coach-1", coachToken: "pat-1" });
  return { manager, onChatActivity, socket: sockets[0]! };
}

function post(message: string, updateAt: number = 1): Record<string, unknown> {
  return {
    id: "post-1",
    channel_id: "channel-1",
    user_id: "coach-1",
    message,
    create_at: 1,
    update_at: updateAt,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Mattermost chat activity", () => {
  it("reports a post by anyone other than the agent", () => {
    const { manager, onChatActivity, socket } = harness();
    socket.message("posted", { ...post("hello"), id: "post-9", user_id: "guest-1", type: "" });

    expect(onChatActivity).toHaveBeenCalledWith({
      defaultAgentMmUserId: "coach-1",
      kind: "post",
      channelId: "channel-1",
      postId: "post-9",
      mmUserId: "guest-1",
    });
    manager.stop();
  });

  it("reports a reaction by anyone other than the agent", () => {
    const { manager, onChatActivity, socket } = harness();
    socket.reaction({ user_id: "builder-1", post_id: "post-1", emoji_name: "+1", create_at: 42 });

    expect(onChatActivity).toHaveBeenCalledWith({
      defaultAgentMmUserId: "coach-1",
      kind: "reaction",
      channelId: "channel-1",
      postId: "post-1",
      mmUserId: "builder-1",
      emojiName: "+1",
      createdAt: 42,
    });
    manager.stop();
  });

  it("ignores the agent's own posts and reactions, edits, bot posts, and system posts", () => {
    const { manager, onChatActivity, socket } = harness();
    socket.message("posted", post("coach reply"));
    socket.reaction({ user_id: "coach-1", post_id: "post-1", emoji_name: "eyes" });
    socket.message("post_edited", { ...post("edit"), user_id: "builder-1" });
    socket.message("posted", {
      ...post("joined"),
      id: "post-4",
      user_id: "builder-1",
      type: "system_join_channel",
    });
    socket.message("posted", {
      ...post("project agent"),
      id: "post-5",
      user_id: "agent-2",
      props: { from_bot: "true" },
    });

    expect(onChatActivity).not.toHaveBeenCalled();
    manager.stop();
  });
});
