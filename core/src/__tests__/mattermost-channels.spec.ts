import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  log: vi.fn(),
  mmApiCall: vi.fn(),
}));

vi.mock("../config.js", () => ({
  log: h.log,
}));

vi.mock("../mattermost/client.js", () => ({
  mmApiCall: h.mmApiCall,
}));

vi.mock("../mattermost/channel-members.js", () => ({
  customerChannelMembers: vi.fn(() => ["mm-customer", "mm-admin"]),
}));

import { createProjectChannel } from "../mattermost/channels.js";

beforeEach(() => {
  vi.clearAllMocks();
  h.mmApiCall.mockReset();
  process.env.MM_URL = "http://mattermost.test";
  process.env.MM_ADMIN_USER_ID = "mm-admin";
});

describe("createProjectChannel", () => {
  it("adds project channel members and returns the channel id", async () => {
    h.mmApiCall.mockImplementation(async (method: string, endpoint: string) => {
      if (method === "POST" && endpoint === "/channels") {
        return { id: "project-channel-1" };
      }
      return {};
    });

    const channelId = await createProjectChannel(
      "team-1",
      "acme",
      "mygame",
      "mm-customer",
      "My Game",
    );

    expect(channelId).toBe("project-channel-1");
    expect(h.mmApiCall).toHaveBeenCalledWith(
      "POST",
      "/channels/project-channel-1/members",
      { user_id: "mm-customer" },
    );
    expect(h.mmApiCall).toHaveBeenCalledWith(
      "POST",
      "/channels/project-channel-1/members",
      { user_id: "mm-admin" },
    );
  });
});
