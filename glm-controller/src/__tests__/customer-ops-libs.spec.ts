import { describe, it, expect, vi } from "vitest";
import {
  deleteAvatarObjects,
  deleteCustomerStorageObjects,
  verifyCustomerStorageErasure,
} from "../lib/customer-ops/avatars";
import { createGiteaCleanupClient, giteaUsername } from "../lib/customer-ops/gitea";
import { createMmCleanupClient } from "../lib/customer-ops/mattermost";

describe("createGiteaCleanupClient", () => {
  function setup(responses: Array<{ status?: number; body?: string }>) {
    let i = 0;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: url.toString(), init });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return new Response(r.body ?? "", { status: r.status ?? 200 });
    }) as unknown as typeof fetch;
    const client = createGiteaCleanupClient({
      apiUrl: "https://gitea.test/api/v1",
      token: "tok-abc",
      fetchImpl,
    });
    return { client, calls };
  }

  it("DELETEs the right Gitea repo URL with the admin token", async () => {
    const { client, calls } = setup([{ status: 200 }]);
    await client.deleteRepo("octogee", "alice-workspace");
    expect(calls[0].url).toBe("https://gitea.test/api/v1/repos/octogee/alice-workspace");
    expect(calls[0].init.method).toBe("DELETE");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("token tok-abc");
  });

  it("treats 404 as success on deleteRepo (idempotent)", async () => {
    const { client } = setup([{ status: 404, body: "not found" }]);
    await expect(client.deleteRepo("octogee", "missing")).resolves.toBeUndefined();
  });

  it("throws on non-404 errors with the status + body in the message", async () => {
    const { client } = setup([{ status: 500, body: "boom" }]);
    await expect(client.deleteRepo("octogee", "x")).rejects.toThrow(/500.*boom/);
  });

  it("DELETEs /orgs/<org> for deleteOrg and treats 404 as success", async () => {
    const { client, calls } = setup([{ status: 200 }]);
    await client.deleteOrg("alice");
    expect(calls[0].url).toBe("https://gitea.test/api/v1/orgs/alice");
    expect(calls[0].init.method).toBe("DELETE");
    const { client: c2 } = setup([{ status: 404, body: "no such org" }]);
    await expect(c2.deleteOrg("gone")).resolves.toBeUndefined();
  });

  it("DELETEs /admin/users/<giteaUsername(slug)> for deleteGiteaUser", async () => {
    const { client, calls } = setup([{ status: 200 }]);
    await client.deleteGiteaUser("alice");
    expect(calls[0].url).toBe(`https://gitea.test/api/v1/admin/users/${giteaUsername("alice")}`);
  });

  it("targets the ws-<slug> username the provisioner actually creates — a wrong name 404s and reads as success", async () => {
    expect(giteaUsername("alice")).toBe("ws-alice");
  });

  it("treats 404 as success on deleteGiteaUser (idempotent)", async () => {
    const { client } = setup([{ status: 404 }]);
    await expect(client.deleteGiteaUser("ghost")).resolves.toBeUndefined();
  });
});

describe("createMmCleanupClient", () => {
  function setup(
    responses: Array<{ status?: number; body?: string }>,
  ): {
    client: ReturnType<typeof createMmCleanupClient>;
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    let i = 0;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: url.toString(), init });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return new Response(r.body ?? "", { status: r.status ?? 200 });
    }) as unknown as typeof fetch;
    const client = createMmCleanupClient({
      baseUrl: "https://mm.test",
      adminToken: "tok-admin",
      fetchImpl,
    });
    return { client, calls };
  }

  it("destroyUser permanently deletes /api/v4/users/<id> — a deactivated user keeps the username reserved", async () => {
    const { client, calls } = setup([{ status: 200 }]);
    await client.destroyUser("u1");
    expect(calls[0].url).toBe("https://mm.test/api/v4/users/u1?permanent=true");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-admin",
    );
  });

  it("destroyChannel hits DELETE /api/v4/channels/<id>; tolerates 404", async () => {
    const { client, calls } = setup([{ status: 404 }]);
    await client.destroyChannel("c1");
    expect(calls[0].url).toBe("https://mm.test/api/v4/channels/c1");
  });

  it("destroyChannel tolerates MM's undeletable-default-channel refusal — town-square dies with the team", async () => {
    const { client } = setup([
      {
        status: 400,
        body: JSON.stringify({
          id: "api.channel.delete_channel.cannot.app_error",
          message: "Unable to delete the default channel town-square.",
        }),
      },
    ]);
    await expect(client.destroyChannel("c-town-square")).resolves.toBeUndefined();
  });

  it("destroyChannel still surfaces other 400s", async () => {
    const { client } = setup([
      { status: 400, body: JSON.stringify({ id: "api.some.other.app_error" }) },
    ]);
    await expect(client.destroyChannel("c1")).rejects.toThrow(/400/);
  });

  it("destroyTeam appends ?permanent=true", async () => {
    const { client, calls } = setup([{ status: 200 }]);
    await client.destroyTeam("t1");
    expect(calls[0].url).toBe("https://mm.test/api/v4/teams/t1?permanent=true");
  });

  it("getUserChannels parses the response into id[]; returns [] on miss", async () => {
    const { client } = setup([{ status: 200, body: JSON.stringify([{ id: "a", type: "O", team_id: "t1" }, { id: "b", type: "P", team_id: "t1" }]) }]);
    const ids = await client.getUserChannels("u1", "t1");
    expect(ids).toEqual(["a", "b"]);
  });

  it("getUserChannels excludes direct and group channels before destructive cleanup", async () => {
    const { client, calls } = setup([{ status: 200, body: JSON.stringify([
      { id: "public", type: "O", team_id: "t1" },
      { id: "direct", type: "D", team_id: "" },
      { id: "group", type: "G", team_id: "" },
      { id: "private", type: "P", team_id: "t1" },
    ]) }]);
    for (const channelId of await client.getUserChannels("u1", "t1")) {
      await client.destroyChannel(channelId);
    }
    expect(calls.filter(call => call.init.method === "DELETE").map(call => call.url))
      .toEqual(["https://mm.test/api/v4/channels/public", "https://mm.test/api/v4/channels/private"]);
  });

  it.each([
    null,
    {},
    [null],
    [{ id: "x", type: "unknown", team_id: "t1" }],
    [{ id: "x", type: "O", team_id: "another-team" }],
    [{ id: "x", type: "P" }],
    [{ type: "O", team_id: "t1" }],
  ])("getUserChannels refuses malformed or foreign-team cleanup authority (%j)", async body => {
    const { client } = setup([{ status: 200, body: JSON.stringify(body) }]);
    await expect(client.getUserChannels("u1", "t1")).rejects.toThrow(/invalid channel/);
  });

  it("getUserChannels returns [] on 404 only — does not silently swallow other errors", async () => {
    const { client } = setup([{ status: 404 }]);
    const ids = await client.getUserChannels("u1", "t1");
    expect(ids).toEqual([]);
  });

  it("getUserChannels surfaces non-404 errors so partial MM cleanup doesn't look successful", async () => {
    const { client } = setup([{ status: 500, body: "internal" }]);
    await expect(client.getUserChannels("u1", "t1")).rejects.toThrow(/500.*internal/);
  });

  it("destroyUser surfaces non-404 errors as thrown Errors", async () => {
    const { client } = setup([{ status: 500, body: "down" }]);
    await expect(client.destroyUser("u1")).rejects.toThrow(/500.*down/);
  });

  it("verifies a user is gone only when Mattermost returns 404", async () => {
    const missing = setup([{ status: 404 }]).client;
    const present = setup([{ status: 200, body: JSON.stringify({ id: "u1" }) }]).client;
    expect(await missing.userExists("u1")).toBe(false);
    expect(await present.userExists("u1")).toBe(true);
  });

  it("revokes only the matching PATs for a resolved bot username", async () => {
    const { client, calls } = setup([
      { status: 200, body: JSON.stringify({ id: "mac-user" }) },
      {
        status: 200,
        body: JSON.stringify([
          { id: "other", description: "another token" },
          { id: "r3-a", description: "revision default-r3" },
          { id: "r3-b", description: "revision default-r3" },
        ]),
      },
      { status: 200 },
      { status: 404 },
    ]);

    await client.revokeTokensForUsernameByDescription("mac-default", "revision default-r3");

    expect(calls.map((call) => call.url)).toEqual([
      "https://mm.test/api/v4/users/username/mac-default",
      "https://mm.test/api/v4/users/mac-user/tokens",
      "https://mm.test/api/v4/users/tokens/revoke",
      "https://mm.test/api/v4/users/tokens/revoke",
    ]);
    expect(calls[0].init.headers).toEqual({ Authorization: "Bearer tok-admin" });
    expect(calls[2].init.method).toBe("POST");
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ token_id: "r3-a" });
    expect(JSON.parse(String(calls[3].init.body))).toEqual({ token_id: "r3-b" });
  });

  it("treats a missing Mac bot as an idempotent no-op", async () => {
    const { client, calls } = setup([{ status: 404 }]);

    await expect(
      client.revokeTokensForUsernameByDescription("mac-default", "revision default-r3"),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("surfaces a failed token lookup instead of marking revision retirement complete", async () => {
    const { client } = setup([
      { status: 200, body: JSON.stringify({ id: "mac-user" }) },
      { status: 500, body: "unavailable" },
    ]);

    await expect(
      client.revokeTokensForUsernameByDescription("mac-default", "revision default-r3"),
    ).rejects.toThrow(/500.*unavailable/);
  });
});

describe("deleteAvatarObjects", () => {
  it("deletes by the avatars/{uid}/ prefix — the gateway-edge upload writes avatars/{uid}/{type}.jpg", async () => {
    const deleteFiles = vi.fn(async () => undefined);
    await deleteAvatarObjects({ deleteFiles }, "uid-alice");
    expect(deleteFiles).toHaveBeenCalledWith({ prefix: "avatars/uid-alice/" });
  });
});

describe("deleteCustomerStorageObjects", () => {
  it("deletes avatars, post covers, and the complete workspace/project blob tree", async () => {
    const deleteFiles = vi.fn(async () => undefined);
    await deleteCustomerStorageObjects(
      { deleteFiles },
      "uid-alice",
      "alice",
      ["a".repeat(64)],
      ["import-1"],
    );
    expect(deleteFiles.mock.calls.map(([arg]) => arg)).toEqual([
      { prefix: "avatars/uid-alice/" },
      { prefix: "post-covers/uid-alice/" },
      { prefix: "agent-imports/uid-alice/" },
      { prefix: "customers/alice/" },
      { prefix: `chat-artifacts/${"a".repeat(64)}/` },
      { prefix: "agent-imports/import-1/" },
    ]);
  });

  it("skips only the slug prefix for a pre-provisioning account", async () => {
    const deleteFiles = vi.fn(async () => undefined);
    await deleteCustomerStorageObjects({ deleteFiles }, "uid-lite", "", [], []);
    expect(deleteFiles.mock.calls.map(([arg]) => arg)).toEqual([
      { prefix: "avatars/uid-lite/" },
      { prefix: "post-covers/uid-lite/" },
      { prefix: "agent-imports/uid-lite/" },
    ]);
  });

  it("reports any object that remains under an identifying customer prefix", async () => {
    const getFiles = vi.fn(async ({ prefix }: { prefix: string }) => [
      prefix === "post-covers/uid-alice/" ? [{ name: `${prefix}cover.jpg` }] : [],
    ]);
    await expect(
      verifyCustomerStorageErasure(
        { getFiles },
        "uid-alice",
        "alice",
        ["a".repeat(64)],
        ["import-1"],
      ),
    ).resolves.toEqual(["gcs/post-covers/uid-alice/cover.jpg"]);
    expect(getFiles).toHaveBeenCalledTimes(6);
  });
});
