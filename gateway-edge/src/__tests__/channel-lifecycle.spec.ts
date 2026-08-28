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

function channel(
  id: string,
  name: string,
  teamId = "team",
  type: "P" | "O" = "P",
  deleteAt = 0,
) {
  return { id, name, team_id: teamId, type, delete_at: deleteAt };
}

beforeEach(() => {
  h.docs.clear();
  h.docs.set("workspaces/alice", { mattermost: { teamId: "team" } });
  h.docs.set(channelPath, {
    kind: "general",
    mattermost: { channelId: "primary" },
  });
  h.mmApi.mockReset();
  h.logger.error.mockReset();
  h.logger.warn.mockReset();
});

describe("channel lifecycle", () => {
  it("joins and leaves the canonical channel", async () => {
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

  it("archives and restores the canonical channel", async () => {
    let deleteAt = 0;
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") {
        return channel("primary", "alice-general", "team", "P", deleteAt);
      }
      if (path === "/channels/primary" && method === "DELETE") {
        deleteAt = Date.now();
        return {};
      }
      if (path === "/channels/primary/restore" && method === "POST") {
        deleteAt = 0;
        return {};
      }
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

  it("treats an already archived primary channel as an idempotent no-op", async () => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") {
        return channel("primary", "alice-general", "team", "P", Date.now());
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    await setStoredPrimaryChannelArchived(channelPath, true);

    expect(h.mmApi).toHaveBeenCalledTimes(1);
    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary");
  });

  it("treats an already active primary channel as an idempotent no-op", async () => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") {
        return channel("primary", "alice-general");
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    await setStoredPrimaryChannelArchived(channelPath, false);

    expect(h.mmApi).toHaveBeenCalledTimes(1);
    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary");
  });

  it("rejects channel state without a numeric deletion timestamp", async () => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") {
        return { ...channel("primary", "alice-general"), delete_at: "0" };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    await expect(setStoredPrimaryChannelArchived(channelPath, true))
      .rejects.toBeInstanceOf(MattermostChannelBindingError);

    expect(h.mmApi).toHaveBeenCalledTimes(1);
    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary");
  });

  it("rejects an already archived channel whose stored binding is forged", async () => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") {
        return channel("primary", "other-general", "other-team", "P", Date.now());
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    await expect(setStoredPrimaryChannelArchived(channelPath, true))
      .rejects.toBeInstanceOf(MattermostChannelBindingError);

    expect(h.mmApi).toHaveBeenCalledTimes(1);
    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary");
  });

  it("maps a missing Mattermost identity without treating channel lifecycle failures as membership errors", () => {
    expect(mapMattermostMembershipError(new MattermostIdentityMissingError("missing"))).toEqual({
      status: 422,
      body: { error: expect.stringMatching(/chat account/i) },
    });
    expect(mapMattermostMembershipError(new MattermostChannelBindingError("forged"))).toBeNull();
  });
});
