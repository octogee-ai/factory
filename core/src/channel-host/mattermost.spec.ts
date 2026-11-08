import { describe, expect, it, vi } from "vitest";

import { createMattermostChannelHost } from "./mattermost.js";

interface Reply {
  status?: number;
  body?: unknown;
}

function setup(replies: Reply[]) {
  let i = 0;
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  const log = vi.fn();
  const fetchImpl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      headers: init.headers as Record<string, string>,
    });
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    const body = reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(body, { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  const host = createMattermostChannelHost({
    baseUrl: "https://mm.test",
    adminToken: "tok-admin",
    fetch: fetchImpl,
    log,
  });
  return { host, calls, log };
}

const NO_SCOPE = { teamId: null, ownerUserId: null, channelIds: [], userIds: [] } as const;

describe("createMattermostChannelHost — membership targets", () => {
  it("adds a team member with team_id and optional roles, and a channel member with user_id only", async () => {
    const { host, calls } = setup([{ body: {} }]);

    await host.addMember({ teamId: "t1" }, "u1", "team_admin team_user");
    await host.addMember({ teamId: "t1" }, "u2");
    await host.addMember({ channelId: "c1" }, "u3");

    expect(calls).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "https://mm.test/api/v4/teams/t1/members",
        body: { team_id: "t1", user_id: "u1", roles: "team_admin team_user" },
      }),
      expect.objectContaining({
        method: "POST",
        url: "https://mm.test/api/v4/teams/t1/members",
        body: { team_id: "t1", user_id: "u2" },
      }),
      expect.objectContaining({
        method: "POST",
        url: "https://mm.test/api/v4/channels/c1/members",
        body: { user_id: "u3" },
      }),
    ]);
    expect(calls[0].headers.Authorization).toBe("Bearer tok-admin");
  });

  it("removes a member from the team or channel it names", async () => {
    const { host, calls } = setup([{ body: {} }]);

    await host.removeMember({ teamId: "t1" }, "u1");
    await host.removeMember({ channelId: "c1" }, "u1");

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "DELETE https://mm.test/api/v4/teams/t1/members/u1",
      "DELETE https://mm.test/api/v4/channels/c1/members/u1",
    ]);
  });
});

describe("createMattermostChannelHost — archiveChannel", () => {
  it("archives a channel found by team and name and returns its id", async () => {
    const { host, calls } = setup([{ body: { id: "c-town" } }, { body: {} }]);

    await expect(host.archiveChannel({ teamId: "t1", name: "town-square" })).resolves.toBe("c-town");
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://mm.test/api/v4/teams/t1/channels/name/town-square",
      "DELETE https://mm.test/api/v4/channels/c-town",
    ]);
  });

  it("returns null without deleting when the named channel is absent", async () => {
    const { host, calls } = setup([{ status: 404, body: { id: "app.channel.get_by_name.missing.app_error" } }]);

    await expect(host.archiveChannel({ teamId: "t1", name: "off-topic" })).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("createMattermostChannelHost — ensureChannel", () => {
  it("returns the channel created by Mattermost", async () => {
    const { host, calls } = setup([{ body: { id: "channel-1", name: "acme-general" } }]);

    const channel = await host.ensureChannel({
      teamId: "team-1",
      name: "acme-general",
      displayName: "General",
      purpose: "Workspace general",
      private: true,
    });

    expect(channel?.id).toBe("channel-1");
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://mm.test/api/v4/channels",
      body: {
        team_id: "team-1",
        name: "acme-general",
        display_name: "General",
        type: "P",
        purpose: "Workspace general",
      },
    });
  });

  it("restores an archived channel when create and lookup miss", async () => {
    const { host, calls, log } = setup([
      { status: 400, body: { id: "store.sql_channel.save_channel.exists.app_error" } },
      { status: 404, body: {} },
      { body: { id: "archived-1", name: "acme-general", delete_at: 7 } },
      { body: { id: "archived-1", name: "acme-general" } },
    ]);

    const channel = await host.ensureChannel({
      teamId: "team-1",
      name: "acme-general",
      displayName: "General",
      purpose: "Workspace general",
      private: true,
    });

    expect(channel?.id).toBe("archived-1");
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://mm.test/api/v4/channels",
      "GET https://mm.test/api/v4/teams/team-1/channels/name/acme-general",
      "GET https://mm.test/api/v4/teams/team-1/channels/name/acme-general?include_deleted=true",
      "POST https://mm.test/api/v4/channels/archived-1/restore",
    ]);
    expect(log).toHaveBeenCalledWith("[mattermost] restored archived channel: acme-general");
  });
});

describe("createMattermostChannelHost — erase", () => {
  it("permanently deletes users — a deactivated user keeps the username reserved", async () => {
    const { host, calls } = setup([{ status: 200 }]);
    await host.erase({ ...NO_SCOPE, userIds: ["u1"] });
    expect(calls[0].url).toBe("https://mm.test/api/v4/users/u1?permanent=true");
    expect(calls[0].headers.Authorization).toBe("Bearer tok-admin");
  });

  it("tolerates an already-deleted channel", async () => {
    const { host, calls } = setup([{ status: 404 }]);
    await expect(host.erase({ ...NO_SCOPE, channelIds: ["c1"] })).resolves.toBeUndefined();
    expect(calls[0].url).toBe("https://mm.test/api/v4/channels/c1");
  });

  it("tolerates MM's undeletable-default-channel refusal — town-square dies with the team", async () => {
    const { host } = setup([
      {
        status: 400,
        body: {
          id: "api.channel.delete_channel.cannot.app_error",
          message: "Unable to delete the default channel town-square.",
        },
      },
    ]);
    await expect(host.erase({ ...NO_SCOPE, channelIds: ["c-town-square"] })).resolves.toBeUndefined();
  });

  it("surfaces other channel 400s", async () => {
    const { host } = setup([{ status: 400, body: { id: "api.some.other.app_error" } }]);
    await expect(host.erase({ ...NO_SCOPE, channelIds: ["c1"] })).rejects.toThrow(/400/);
  });

  it("permanently deletes the team", async () => {
    const { host, calls } = setup([{ status: 200 }]);
    await host.erase({ ...NO_SCOPE, teamId: "t1" });
    expect(calls[0].url).toBe("https://mm.test/api/v4/teams/t1?permanent=true");
  });

  it("deletes the owner's team channels, then the owner, extra channels, extra users, and the team", async () => {
    const { host, calls } = setup([
      { body: [{ id: "a", type: "O", team_id: "t1" }, { id: "b", type: "P", team_id: "t1" }] },
      { status: 200 },
    ]);

    await host.erase({ teamId: "t1", ownerUserId: "u1", channelIds: ["c-admin"], userIds: ["coach"] });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://mm.test/api/v4/users/u1/teams/t1/channels",
      "DELETE https://mm.test/api/v4/channels/a",
      "DELETE https://mm.test/api/v4/channels/b",
      "DELETE https://mm.test/api/v4/users/u1?permanent=true",
      "DELETE https://mm.test/api/v4/channels/c-admin",
      "DELETE https://mm.test/api/v4/users/coach?permanent=true",
      "DELETE https://mm.test/api/v4/teams/t1?permanent=true",
    ]);
  });

  it("deletes a known owner without listing channels when the team is already gone", async () => {
    const { host, calls } = setup([{ status: 200 }]);
    await host.erase({ ...NO_SCOPE, ownerUserId: "u-orphan" });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "DELETE https://mm.test/api/v4/users/u-orphan?permanent=true",
    ]);
  });

  it("excludes direct and group channels before destructive cleanup", async () => {
    const { host, calls } = setup([
      {
        body: [
          { id: "public", type: "O", team_id: "t1" },
          { id: "direct", type: "D", team_id: "" },
          { id: "group", type: "G", team_id: "" },
          { id: "private", type: "P", team_id: "t1" },
        ],
      },
      { status: 200 },
    ]);
    await host.erase({ ...NO_SCOPE, teamId: "t1", ownerUserId: "u1" });
    expect(calls.filter((call) => call.method === "DELETE" && call.url.includes("/channels/")).map((call) => call.url)).toEqual([
      "https://mm.test/api/v4/channels/public",
      "https://mm.test/api/v4/channels/private",
    ]);
  });

  it.each([
    null,
    {},
    [null],
    [{ id: "x", type: "unknown", team_id: "t1" }],
    [{ id: "x", type: "O", team_id: "another-team" }],
    [{ id: "x", type: "P" }],
    [{ type: "O", team_id: "t1" }],
  ])("refuses malformed or foreign-team channel listings (%j)", async (body) => {
    const { host, calls } = setup([{ body: JSON.stringify(body) }]);
    await expect(host.erase({ ...NO_SCOPE, teamId: "t1", ownerUserId: "u1" })).rejects.toThrow(/invalid channel/);
    expect(calls).toHaveLength(1);
  });

  it("treats a 404 channel listing as no channels", async () => {
    const { host, calls } = setup([{ status: 404 }, { status: 200 }]);
    await host.erase({ ...NO_SCOPE, teamId: "t1", ownerUserId: "u1" });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://mm.test/api/v4/users/u1/teams/t1/channels",
      "DELETE https://mm.test/api/v4/users/u1?permanent=true",
      "DELETE https://mm.test/api/v4/teams/t1?permanent=true",
    ]);
  });

  it("surfaces a failed channel listing so partial cleanup does not look successful", async () => {
    const { host } = setup([{ status: 500, body: "internal" }]);
    await expect(host.erase({ ...NO_SCOPE, teamId: "t1", ownerUserId: "u1" })).rejects.toThrow(/500.*internal/);
  });

  it("surfaces a failed user delete", async () => {
    const { host } = setup([{ status: 500, body: "down" }]);
    await expect(host.erase({ ...NO_SCOPE, userIds: ["u1"] })).rejects.toThrow(/500.*down/);
  });
});

describe("createMattermostChannelHost — userExists", () => {
  it("reports a user gone only when Mattermost returns 404", async () => {
    expect(await setup([{ status: 404 }]).host.userExists("u1")).toBe(false);
    expect(await setup([{ body: { id: "u1" } }]).host.userExists("u1")).toBe(true);
    await expect(setup([{ status: 500, body: "down" }]).host.userExists("u1")).rejects.toThrow(/500.*down/);
  });
});
