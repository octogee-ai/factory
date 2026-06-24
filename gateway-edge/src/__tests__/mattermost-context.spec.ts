import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const userDoc = {
    data: vi.fn<() => Record<string, unknown> | undefined>(),
  };
  const db = {
    doc: vi.fn((path: string) => ({
      path,
      get: vi.fn(async () => userDoc),
    })),
  };
  return {
    userDoc,
    db,
    readWorkspace: vi.fn(),
    readChannel: vi.fn(),
    readAgent: vi.fn(),
  };
});

vi.mock("../lib/db.js", () => ({
  db: h.db,
}));

vi.mock("../lib/firestoreReads.js", () => ({
  readWorkspace: h.readWorkspace,
  readChannel: h.readChannel,
  readAgent: h.readAgent,
}));

const { getWorkspaceMmContext } = await import("../lib/mattermost-context.js");

describe("getWorkspaceMmContext", () => {
  beforeEach(() => {
    h.userDoc.data.mockReset();
    h.db.doc.mockClear();
    h.readWorkspace.mockReset();
    h.readChannel.mockReset();
    h.readAgent.mockReset();
  });

  it("returns null when the owner user document is missing", async () => {
    h.userDoc.data.mockReturnValue(undefined);

    await expect(getWorkspaceMmContext("uid-1")).resolves.toBeNull();

    expect(h.db.doc).toHaveBeenCalledWith("users/uid-1");
    expect(h.readWorkspace).not.toHaveBeenCalled();
  });

  it("assembles workspace Mattermost ids from user, workspace, channels, and agent", async () => {
    h.readWorkspace.mockResolvedValue({ mattermost: { teamId: "team-1" } });
    h.readAgent.mockResolvedValue({ mattermost: { userId: "coach-mm" } });
    h.readChannel.mockImplementation(async (ref: { path: string }) => {
      if (ref.path.endsWith("/general")) return { mattermost: { channelId: "general-ch" } };
      if (ref.path.endsWith("/coach-dm")) return { mattermost: { channelId: "coach-dm-ch" } };
      if (ref.path.endsWith("/admin")) return { mattermost: { channelId: "admin-ch" } };
      return null;
    });

    const ctx = await getWorkspaceMmContext("uid-1", undefined, {
      username: "alice",
      mattermost: { userId: "owner-mm", username: "alice-mm" },
    });

    expect(ctx).toEqual({
      ownerUid: "uid-1",
      slug: "alice",
      teamId: "team-1",
      userId: "owner-mm",
      username: "alice-mm",
      coachUserId: "coach-mm",
      coachDmChannelId: "coach-dm-ch",
      generalChannelId: "general-ch",
      adminChannelId: "admin-ch",
    });
  });
});
