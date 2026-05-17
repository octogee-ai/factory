import { describe, it, expect, vi } from "vitest";
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

  it("destroyUser hits DELETE /api/v4/users/<id> with bearer token", async () => {
    const { client, calls } = setup([{ status: 200 }]);
    await client.destroyUser("u1");
    expect(calls[0].url).toBe("https://mm.test/api/v4/users/u1");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-admin",
    );
  });

  it("destroyChannel hits DELETE /api/v4/channels/<id>; tolerates 404", async () => {
    const { client, calls } = setup([{ status: 404 }]);
    await client.destroyChannel("c1");
    expect(calls[0].url).toBe("https://mm.test/api/v4/channels/c1");
  });

  it("destroyTeam appends ?permanent=true", async () => {
    const { client, calls } = setup([{ status: 200 }]);
    await client.destroyTeam("t1");
    expect(calls[0].url).toBe("https://mm.test/api/v4/teams/t1?permanent=true");
  });

  it("getUserChannels parses the response into id[]; returns [] on miss", async () => {
    const { client } = setup([{ status: 200, body: JSON.stringify([{ id: "a" }, { id: "b" }]) }]);
    const ids = await client.getUserChannels("u1", "t1");
    expect(ids).toEqual(["a", "b"]);
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
});
