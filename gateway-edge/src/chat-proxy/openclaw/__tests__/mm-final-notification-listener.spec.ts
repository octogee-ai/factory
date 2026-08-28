import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startMmFinalNotificationListeners,
  type MmFinalNotificationListenerDeps,
} from "../mm-final-notification-listener.js";

class FakeWs extends EventEmitter {
  send = vi.fn();
  close(): void {
    this.emit("close");
  }
  message(event: "posted" | "post_edited", post: Record<string, unknown>): void {
    this.emit("message", JSON.stringify({ event, data: { post: JSON.stringify(post) } }));
  }
}

function harness(overrides: Partial<MmFinalNotificationListenerDeps> = {}) {
  const sockets: FakeWs[] = [];
  const onCoachDm = vi.fn();
  const manager = startMmFinalNotificationListeners({
    log: vi.fn(),
    openWebSocket: () => {
      const socket = new FakeWs();
      sockets.push(socket);
      return socket as unknown as import("ws").WebSocket;
    },
    onCoachDm,
    postSettleMs: 10,
    backoffSchedule: [10],
    ...overrides,
  });
  manager.addCoach({ coachMmUserId: "coach-1", coachToken: "pat-1" });
  return { manager, onCoachDm, socket: sockets[0]! };
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

describe("Mattermost final-post notifications", () => {
  it("debounces draft edits and emits only the stable final content", async () => {
    const { manager, onCoachDm, socket } = harness();
    socket.message("posted", post("Draft", 1));
    socket.message("post_edited", post("Final answer", 2));

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onCoachDm).toHaveBeenCalledTimes(1);
    expect(onCoachDm).toHaveBeenCalledWith({
      coachMmUserId: "coach-1",
      channelId: "channel-1",
      postId: "post-1",
      message: "Final answer",
      createdAt: 1,
    });
    manager.stop();
  });

  it("never notifies for a post whose stable edit is blank", async () => {
    const { manager, onCoachDm, socket } = harness();
    socket.message("posted", post("Draft", 1));
    socket.message("post_edited", post("", 2));

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onCoachDm).not.toHaveBeenCalled();
    manager.stop();
  });

  it("ignores foreign authors and Octogee detail posts", async () => {
    const { manager, onCoachDm, socket } = harness();
    socket.message("posted", { ...post("Foreign"), id: "post-2", user_id: "builder-1" });
    socket.message("posted", {
      ...post("Tool detail"),
      id: "post-3",
      props: { octogee: { kind: "activity" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onCoachDm).not.toHaveBeenCalled();
    manager.stop();
  });

  it("deduplicates repeated lifecycle events for the same post", async () => {
    const { manager, onCoachDm, socket } = harness();
    socket.message("posted", post("Final", 2));
    socket.message("post_edited", post("Final", 2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.message("post_edited", post("Final", 2));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onCoachDm).toHaveBeenCalledTimes(1);
    manager.stop();
  });
});
