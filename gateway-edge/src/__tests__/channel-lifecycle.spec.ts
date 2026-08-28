import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  mmApi: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../lib/db.js", () => ({
  db: {
    doc: (path: string) => ({
      get: async () => {
        const data = h.docs.get(path);
        return { exists: data !== undefined, data: () => data };
      },
    }),
  },
}));

vi.mock("../lib/mattermost.js", () => ({
  mmApi: (...args: unknown[]) => h.mmApi(...args),
}));

vi.mock("../middleware/logging.js", () => ({ logger: h.logger }));

const {
  MattermostChannelBindingError,
  MattermostIdentityMissingError,
  addChannelMember,
  mapMattermostMembershipError,
  removeChannelMember,
  setStoredChannelArchived,
  setStoredPrimaryChannelArchived,
} = await import("../lib/channel-lifecycle.js");

const channelPath = "workspaces/alice/channels/general";

function channel(id: string, name: string, teamId = "team", type: "P" | "O" = "P") {
  return { id, name, team_id: teamId, type };
}

beforeEach(() => {
  h.docs.clear();
  h.docs.set("workspaces/alice", { mattermost: { teamId: "team" } });
  h.docs.set(channelPath, {
    kind: "general",
    mattermost: { channelId: "primary", activityChannelId: "legacy" },
  });
  h.mmApi.mockReset();
  h.logger.error.mockReset();
  h.logger.warn.mockReset();
});

describe("channel lifecycle", () => {
  it("joins and leaves only the primary channel even when a legacy sibling is stored", async () => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") return channel("primary", "alice-general");
      if (path === "/users/member" && method === "GET") return { id: "member", delete_at: 0 };
      if (path === "/channels/primary/members" && method === "POST") return {};
      if (path === "/channels/primary/members/member" && method === "DELETE") return {};
      throw new Error(`unexpected ${method} ${path}`);
    });

    await addChannelMember(channelPath, "member");
    await removeChannelMember(channelPath, "member");

    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary/members", "POST", { user_id: "member" });
    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary/members/member", "DELETE");
    expect(h.mmApi.mock.calls.some(([path]) => String(path).includes("legacy"))).toBe(false);
  });

  it.each([
    ["add", addChannelMember],
    ["remove", removeChannelMember],
  ] as const)("refuses to %s membership through a forged primary pointer", async (_operation, mutate) => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") {
        return channel("primary", "other-general", "other-team");
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    await expect(mutate(channelPath, "member"))
      .rejects.toBeInstanceOf(MattermostChannelBindingError);

    expect(h.mmApi).toHaveBeenCalledTimes(1);
    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary");
    expect(h.mmApi.mock.calls.some(([, method]) => method === "POST" || method === "DELETE")).toBe(false);
  });

  it("archives and restores the primary independently from a stored legacy sibling", async () => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") return channel("primary", "alice-general");
      if (path === "/channels/primary" && method === "DELETE") return {};
      if (path === "/channels/primary/restore" && method === "POST") return {};
      throw new Error(`unexpected ${method} ${path}`);
    });

    await setStoredPrimaryChannelArchived(channelPath, true);
    await setStoredPrimaryChannelArchived(channelPath, false);

    expect(h.mmApi.mock.calls).toEqual([
      ["/channels/primary"],
      ["/channels/primary", "DELETE"],
      ["/channels/primary"],
      ["/channels/primary/restore", "POST"],
    ]);
  });

  it("changes the primary lifecycle without binding or mutating a legacy history pointer", async () => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") return channel("primary", "alice-general");
      if (path === "/channels/primary" && method === "DELETE") return {};
      throw new Error(`unexpected ${method} ${path}`);
    });

    await setStoredChannelArchived(channelPath, true);

    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary");
    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary", "DELETE");
    expect(h.mmApi.mock.calls.some(([path]) => String(path).includes("legacy"))).toBe(false);
  });

  it("maps a missing Mattermost identity without treating channel lifecycle failures as membership errors", () => {
    expect(mapMattermostMembershipError(new MattermostIdentityMissingError("missing"))).toEqual({
      status: 422,
      body: { error: expect.stringMatching(/chat account/i) },
    });
    expect(mapMattermostMembershipError(new MattermostChannelBindingError("forged"))).toBeNull();
  });
});
