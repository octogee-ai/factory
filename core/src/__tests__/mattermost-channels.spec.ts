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

import {
  createOrRestoreChannel,
  createProjectChannel,
} from "../mattermost/channels.js";

beforeEach(() => {
  vi.clearAllMocks();
  h.mmApiCall.mockReset();
  process.env.MM_URL = "http://mattermost.test";
  process.env.MM_ADMIN_USER_ID = "mm-admin";
});

describe("createOrRestoreChannel", () => {
  it("returns the channel created by Mattermost", async () => {
    h.mmApiCall.mockResolvedValueOnce({ id: "channel-1", name: "acme-general" });

    const channel = await createOrRestoreChannel(
      "team-1",
      "acme-general",
      "General",
      "P",
      "Workspace general",
    );

    expect(channel?.id).toBe("channel-1");
    expect(h.mmApiCall).toHaveBeenCalledWith("POST", "/channels", {
      team_id: "team-1",
      name: "acme-general",
      display_name: "General",
      type: "P",
      purpose: "Workspace general",
    });
  });

  it("restores an archived channel when create and lookup miss", async () => {
    h.mmApiCall
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "archived-1", name: "acme-general", delete_at: 7 })
      .mockResolvedValueOnce({ id: "archived-1", name: "acme-general" });

    const channel = await createOrRestoreChannel(
      "team-1",
      "acme-general",
      "General",
      "P",
      "Workspace general",
    );

    expect(channel?.id).toBe("archived-1");
    expect(h.mmApiCall).toHaveBeenCalledWith(
      "GET",
      "/teams/team-1/channels/name/acme-general?include_deleted=true",
    );
    expect(h.mmApiCall).toHaveBeenCalledWith("POST", "/channels/archived-1/restore");
    expect(h.log).toHaveBeenCalledWith("[mattermost] restored archived channel: acme-general");
  });
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
