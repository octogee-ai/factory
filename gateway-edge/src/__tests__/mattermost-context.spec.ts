import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const docs = new Map<string, Record<string, unknown>>();
  const db = {
    doc: vi.fn((path: string) => ({
      path,
      get: vi.fn(async () => ({ data: () => docs.get(path) })),
    })),
  };
  return { docs, db };
});

vi.mock("../lib/db.js", () => ({
  db: h.db,
}));

vi.mock("../lib/platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});

const { getWorkspaceMmContext } = await import("../lib/mattermost-context.js");

describe("getWorkspaceMmContext", () => {
  beforeEach(() => {
    h.docs.clear();
    h.db.doc.mockClear();
  });

  it("returns null when the owner user document is missing", async () => {
    await expect(getWorkspaceMmContext("uid-1")).resolves.toBeNull();

    expect(h.db.doc).toHaveBeenCalledWith("users/uid-1");
  });

  it("assembles workspace Mattermost ids from the platform records and product username", async () => {
    h.docs.set("users/uid-1", { username: "alice", mattermost: { userId: "owner-mm", username: "alice-mm" } });
    h.docs.set("workspaces/alice", { id: "alice", ownerUid: "uid-1", mattermost: { teamId: "team-1" } });
    h.docs.set("agents/uid-1", { mattermost: { userId: "coach-mm" } });
    h.docs.set("workspaces/alice/channels/general", { mattermost: { channelId: "general-ch" } });
    h.docs.set("workspaces/alice/channels/coach-dm", { mattermost: { channelId: "coach-dm-ch" } });
    h.docs.set("workspaces/alice/channels/admin", { mattermost: { channelId: "admin-ch" } });

    const ctx = await getWorkspaceMmContext("uid-1", undefined, {
      username: "alice",
      mattermost: { userId: "stale-projected-mm", username: "alice-mm" },
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
