import { beforeEach, describe, expect, it } from "vitest";
import { executeChatHistory, type ChatBrokerIdentity } from "../lib/chat-broker/execute.js";
import { _resetTeamCachesForTests } from "../lib/chat-broker/team.js";
import type { MmClient } from "../lib/chat-broker/mm-client.js";

const IDENTITY: ChatBrokerIdentity = {
  pat: "builder-pat",
  coachMmUserId: "mm-coach-bot",
  unread: { pat: "coach-pat", mmUserId: "mm-coach-bot" },
  slug: "alice",
  siteUrl: "https://chat.example",
};

function fakeMm(calls: Array<{ path: string; pat: string }>): MmClient {
  return {
    get: async (path: string, pat: string) => {
      calls.push({ path, pat });
      if (path.startsWith("/api/v4/teams/name/")) return { id: "team-1" };
      if (path.includes("/channels/name/")) return { id: "abcdefghijklmnopqrstuvwxyz" };
      if (path.includes("/posts")) return { posts: {}, order: [] };
      if (path.startsWith("/api/v4/channels/")) {
        return { id: "abcdefghijklmnopqrstuvwxyz", name: "alice-general", display_name: "General" };
      }
      return {};
    },
    post: async (path: string, pat: string) => {
      calls.push({ path, pat });
      return [];
    },
  };
}

beforeEach(() => _resetTeamCachesForTests());

describe("executeChatHistory — unread runs under the agent bot's own PAT", () => {
  it("direction=unread fetches the BOT's cursor with the BOT's PAT, not the builder's", async () => {
    const calls: Array<{ path: string; pat: string }> = [];
    await executeChatHistory(IDENTITY, { channel: "alice-general", direction: "unread" }, fakeMm(calls));

    const unreadCall = calls.find((c) => c.path.includes("/posts/unread"));
    expect(unreadCall).toBeDefined();
    expect(unreadCall!.path).toContain("/users/mm-coach-bot/");
    expect(unreadCall!.pat).toBe("coach-pat");
  });

  it("every other direction reads under the lane PAT (the builder's, for the workspace agent)", async () => {
    const calls: Array<{ path: string; pat: string }> = [];
    await executeChatHistory(IDENTITY, { channel: "alice-general", direction: "latest" }, fakeMm(calls));

    const postsCall = calls.find((c) => /\/channels\/[a-z0-9]{26}\/posts\?/.test(c.path));
    expect(postsCall).toBeDefined();
    expect(postsCall!.pat).toBe("builder-pat");
  });
});
