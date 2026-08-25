import { describe, expect, it, vi } from "vitest";
import {
  parseSilentPostProbeArgs,
  verifySilentPostCapability,
} from "../lib/mattermost/verify-silent-post.js";

describe("Mattermost silent-post capability verifier", () => {
  it("proves persistence, websocket delivery, zero unread/mentions, normal final attention, and human denial", async () => {
    const unread = [
      { msgCount: 0, mentionCount: 0 },
      { msgCount: 0, mentionCount: 0 },
      { msgCount: 1, mentionCount: 1 },
    ];
    const readUnread = vi.fn(async () => unread.shift()!);
    const createPost = vi.fn()
      .mockResolvedValueOnce({ status: 201, id: "silent-1", props: { silent_notification: true } })
      .mockResolvedValueOnce({ status: 201, id: "final-1", props: {} })
      .mockResolvedValueOnce({ status: 403 })
      .mockResolvedValueOnce({ status: 400 });
    const waitForWebsocketPost = vi.fn(async () => undefined);

    const report = await verifySilentPostCapability({
      readUnread,
      createPost,
      waitForWebsocketPost,
    });

    expect(report).toEqual({
      persisted: true,
      websocketDelivered: true,
      unreadUnchanged: true,
      mentionUnchanged: true,
      ordinaryFinalNotifies: true,
      humanSilentRejected: true,
      persistentSilentRejected: true,
    });
    expect(waitForWebsocketPost.mock.calls).toEqual([["silent-1"], ["final-1"]]);
    expect(createPost.mock.calls.map(([request]) => request)).toEqual([
      { actor: "bot", message: expect.any(String), silent: true, persistentNotification: false },
      { actor: "bot", message: expect.any(String), silent: false, persistentNotification: false },
      { actor: "human", message: expect.any(String), silent: true, persistentNotification: false },
      { actor: "bot", message: expect.any(String), silent: true, persistentNotification: true },
    ]);
  });

  it("accepts a server rejection when persistent notifications are unavailable in the edition", async () => {
    const unread = [
      { msgCount: 0, mentionCount: 0 },
      { msgCount: 0, mentionCount: 0 },
      { msgCount: 1, mentionCount: 1 },
    ];
    const report = await verifySilentPostCapability({
      readUnread: vi.fn(async () => unread.shift()!),
      createPost: vi.fn()
        .mockResolvedValueOnce({ status: 201, id: "silent-1", props: { silent_notification: true } })
        .mockResolvedValueOnce({ status: 201, id: "final-1", props: {} })
        .mockResolvedValueOnce({ status: 403 })
        .mockResolvedValueOnce({ status: 501 }),
      waitForWebsocketPost: vi.fn(async () => undefined),
    });

    expect(report.persistentSilentRejected).toBe(true);
  });

  it("parses a runnable TEST/prod-neutral operator entrypoint without defaulting credentials", () => {
    expect(parseSilentPostProbeArgs([
      "--base-url=https://mattermost.example",
      "--channel-id=channel-1",
      "--observer-user-id=user-1",
      "--observer-username=builder",
    ], {
      MM_BOT_TOKEN: "bot-token",
      MM_HUMAN_TOKEN: "human-token",
      MM_OBSERVER_TOKEN: "observer-token",
    })).toEqual({
      baseUrl: "https://mattermost.example",
      channelId: "channel-1",
      observerUserId: "user-1",
      observerUsername: "builder",
      botToken: "bot-token",
      humanToken: "human-token",
      observerToken: "observer-token",
    });
    expect(parseSilentPostProbeArgs([], {})).toBeNull();
  });
});
