import { describe, expect, it, vi } from "vitest";
import { makeChatActivityDemandHandler } from "../chat-activity-demand.js";

const activity = {
  defaultAgentMmUserId: "coach-1",
  kind: "reaction" as const,
  channelId: "channel-1",
  postId: "post-1",
  mmUserId: "guest-1",
  emojiName: "tada",
  createdAt: 42,
};

describe("chat activity demand handler", () => {
  it("reports the observed activity without the agent identity", async () => {
    const requestChatActivityDemand = vi.fn(async () => ({ recorded: true }));
    const log = vi.fn();

    await makeChatActivityDemandHandler({ broker: { requestChatActivityDemand }, log })(activity);

    expect(requestChatActivityDemand).toHaveBeenCalledWith({
      kind: "reaction",
      channelId: "channel-1",
      postId: "post-1",
      mmUserId: "guest-1",
      emojiName: "tada",
      createdAt: 42,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("warns when the broker refuses or fails the report", async () => {
    const requestChatActivityDemand = vi.fn(async () => {
      throw new Error("broker HTTP 409");
    });
    const log = vi.fn();

    await makeChatActivityDemandHandler({ broker: { requestChatActivityDemand }, log })(activity);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("broker HTTP 409"),
      "warn",
    );
  });
});

describe("chat activity demand throttle", () => {
  function throttled(outcomes: Array<Record<string, unknown> | Error>) {
    let now = 0;
    const requestChatActivityDemand = vi.fn(async () => {
      const next = outcomes.shift() ?? { recorded: true };
      if (next instanceof Error) throw next;
      return next;
    });
    const handle = makeChatActivityDemandHandler({
      broker: { requestChatActivityDemand },
      log: vi.fn(),
      windowMs: 1_000,
      now: () => now,
    });
    return { handle, requestChatActivityDemand, advance: (ms: number) => { now += ms; } };
  }

  it("reports each channel at most once per window, first message immediately", async () => {
    const { handle, requestChatActivityDemand, advance } = throttled([]);

    await handle(activity);
    await handle({ ...activity, postId: "post-2" });
    await handle({ ...activity, channelId: "channel-2" });
    advance(999);
    await handle(activity);
    expect(requestChatActivityDemand).toHaveBeenCalledTimes(2);

    advance(1);
    await handle(activity);
    expect(requestChatActivityDemand).toHaveBeenCalledTimes(3);
  });

  it("keeps the channel open after a failure or a non-human author", async () => {
    const { handle, requestChatActivityDemand } = throttled([
      new Error("broker HTTP 503"),
      { recorded: false, reason: "actor-not-human" },
      { recorded: false, reason: "owner-not-disposable-builder" },
    ]);

    await handle(activity);
    await handle(activity);
    await handle(activity);
    await handle(activity);

    expect(requestChatActivityDemand).toHaveBeenCalledTimes(3);
  });
});
