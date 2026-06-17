import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const OLD_ENV = { ...process.env };
const BASE = "http://gitea.test:3000/api/v1";

function res(status: number, body: unknown = {}): Response {
  const noBody = status === 204 || status === 304;
  return new Response(noBody ? null : JSON.stringify(body), { status });
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>): Array<{ url: string; method: string; body: unknown }> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init?.method ?? "GET") as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
}

describe("gateway-edge gitea-admin — provisioner admin ops on GITEA_TOKEN", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.GITEA_URL = "http://gitea.test:3000";
    process.env.GITEA_TOKEN = "admin-tok";
    process.env.K8S_NAMESPACE = "octogee";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...OLD_ENV };
  });

  describe("ensureGiteaUser", () => {
    it("creates the ws-<slug> user and registers the octogee-gateway ssh key", async () => {
      fetchMock
        .mockResolvedValueOnce(res(201, { id: 1 })) // POST /admin/users
        .mockResolvedValueOnce(res(200, [])) // GET existing keys
        .mockResolvedValueOnce(res(201, { id: 9 })); // POST key
      const { ensureGiteaUser } = await import("../gitea-admin.js");
      await ensureGiteaUser("acme", "ssh-ed25519 AAAABBB octogee-acme@gateway");

      const calls = callsTo(fetchMock);
      expect(calls[0]).toMatchObject({ url: `${BASE}/admin/users`, method: "POST" });
      expect(calls[0].body).toMatchObject({
        username: "ws-acme",
        email: "acme@octogee.local",
        must_change_password: false,
        visibility: "private",
      });
      expect((calls[0].body as { password?: string }).password).toMatch(/^[0-9a-f]{64}$/);
      expect(calls[1]).toMatchObject({ url: `${BASE}/users/ws-acme/keys`, method: "GET" });
      expect(calls[2]).toMatchObject({ url: `${BASE}/admin/users/ws-acme/keys`, method: "POST" });
      expect(calls[2].body).toMatchObject({
        title: "octogee-gateway",
        key: "ssh-ed25519 AAAABBB octogee-acme@gateway",
      });
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("token admin-tok");
    });

    it("treats 422 (user already exists) as success", async () => {
      fetchMock
        .mockResolvedValueOnce(res(422, { message: "user already exists" }))
        .mockResolvedValueOnce(res(200, []))
        .mockResolvedValueOnce(res(201, {}));
      const { ensureGiteaUser } = await import("../gitea-admin.js");
      await expect(ensureGiteaUser("acme", "ssh-ed25519 K")).resolves.toBeUndefined();
    });

    it("deletes a stale octogee-gateway key before registering the new one", async () => {
      fetchMock
        .mockResolvedValueOnce(res(422, {})) // user exists
        .mockResolvedValueOnce(res(200, [{ id: 7, title: "octogee-gateway" }, { id: 8, title: "other" }]))
        .mockResolvedValueOnce(res(204)) // DELETE key 7
        .mockResolvedValueOnce(res(201, {})); // POST new key
      const { ensureGiteaUser } = await import("../gitea-admin.js");
      await ensureGiteaUser("acme", "ssh-ed25519 NEW");

      const calls = callsTo(fetchMock);
      expect(calls[2]).toMatchObject({ url: `${BASE}/admin/users/ws-acme/keys/7`, method: "DELETE" });
      expect(calls[3]).toMatchObject({ url: `${BASE}/admin/users/ws-acme/keys`, method: "POST" });
    });

    it("throws (no silent failure) when key registration fails", async () => {
      fetchMock
        .mockResolvedValueOnce(res(201, {}))
        .mockResolvedValueOnce(res(200, []))
        .mockResolvedValueOnce(res(500, { message: "boom" }));
      const { ensureGiteaUser } = await import("../gitea-admin.js");
      await expect(ensureGiteaUser("acme", "ssh-ed25519 K")).rejects.toThrow();
    });

    it("throws when user creation fails with a non-422 status", async () => {
      fetchMock.mockResolvedValueOnce(res(500, { message: "down" }));
      const { ensureGiteaUser } = await import("../gitea-admin.js");
      await expect(ensureGiteaUser("acme", "ssh-ed25519 K")).rejects.toThrow();
    });
  });

  describe("readGiteaUserPubKey", () => {
    it("returns the trimmed octogee-gateway key", async () => {
      fetchMock.mockResolvedValueOnce(
        res(200, [
          { id: 1, title: "other", key: "ssh-ed25519 OTHER" },
          { id: 2, title: "octogee-gateway", key: "ssh-ed25519 WANT octogee\n" },
        ]),
      );
      const { readGiteaUserPubKey } = await import("../gitea-admin.js");
      expect(await readGiteaUserPubKey("acme")).toBe("ssh-ed25519 WANT octogee");
      expect(callsTo(fetchMock)[0]).toMatchObject({ url: `${BASE}/users/ws-acme/keys`, method: "GET" });
    });

    it("returns null on 404 (user not provisioned)", async () => {
      fetchMock.mockResolvedValueOnce(res(404, {}));
      const { readGiteaUserPubKey } = await import("../gitea-admin.js");
      expect(await readGiteaUserPubKey("acme")).toBeNull();
    });

    it("returns null when no octogee-gateway key is present", async () => {
      fetchMock.mockResolvedValueOnce(res(200, [{ id: 1, title: "other", key: "x" }]));
      const { readGiteaUserPubKey } = await import("../gitea-admin.js");
      expect(await readGiteaUserPubKey("acme")).toBeNull();
    });
  });

  describe("ensureGiteaOrgForWorkspace", () => {
    it("creates org + builders team + adds the ws user as member", async () => {
      fetchMock
        .mockResolvedValueOnce(res(201, {})) // POST /orgs
        .mockResolvedValueOnce(res(201, { id: 5 })) // POST /orgs/acme/teams
        .mockResolvedValueOnce(res(204)); // PUT member
      const { ensureGiteaOrgForWorkspace } = await import("../gitea-admin.js");
      await ensureGiteaOrgForWorkspace("acme");

      const calls = callsTo(fetchMock);
      expect(calls[0]).toMatchObject({ url: `${BASE}/orgs`, method: "POST" });
      expect(calls[0].body).toMatchObject({ username: "acme", visibility: "private" });
      expect(calls[1]).toMatchObject({ url: `${BASE}/orgs/acme/teams`, method: "POST" });
      expect(calls[1].body).toMatchObject({ name: "builders", permission: "write" });
      expect(calls[2]).toMatchObject({ url: `${BASE}/teams/5/members/ws-acme`, method: "PUT" });
    });

    it("resolves an existing builders team when create returns 422", async () => {
      fetchMock
        .mockResolvedValueOnce(res(422, {})) // org exists
        .mockResolvedValueOnce(res(422, {})) // team exists
        .mockResolvedValueOnce(res(200, [{ id: 9, name: "builders" }])) // GET teams
        .mockResolvedValueOnce(res(204)); // PUT member
      const { ensureGiteaOrgForWorkspace } = await import("../gitea-admin.js");
      await ensureGiteaOrgForWorkspace("acme");

      const calls = callsTo(fetchMock);
      expect(calls[2]).toMatchObject({ url: `${BASE}/orgs/acme/teams`, method: "GET" });
      expect(calls[3]).toMatchObject({ url: `${BASE}/teams/9/members/ws-acme`, method: "PUT" });
    });
  });

  describe("ensureWorkspaceRepo", () => {
    it("creates the private workspace repo with auto_init false", async () => {
      fetchMock.mockResolvedValueOnce(res(201, {}));
      const { ensureWorkspaceRepo } = await import("../gitea-admin.js");
      await ensureWorkspaceRepo("acme");

      const c = callsTo(fetchMock)[0];
      expect(c).toMatchObject({ url: `${BASE}/orgs/acme/repos`, method: "POST" });
      expect(c.body).toMatchObject({ name: "workspace", private: true, auto_init: false });
    });

    it("treats 409 (already exists) as success", async () => {
      fetchMock.mockResolvedValueOnce(res(409, {}));
      const { ensureWorkspaceRepo } = await import("../gitea-admin.js");
      await expect(ensureWorkspaceRepo("acme")).resolves.toBeUndefined();
    });
  });

  describe("ensureSystemConfigRepo", () => {
    it("creates the private system_config repo with auto_init false", async () => {
      fetchMock.mockResolvedValueOnce(res(201, {}));
      const { ensureSystemConfigRepo } = await import("../gitea-admin.js");
      await ensureSystemConfigRepo("acme");

      const c = callsTo(fetchMock)[0];
      expect(c).toMatchObject({ url: `${BASE}/orgs/acme/repos`, method: "POST" });
      expect(c.body).toMatchObject({ name: "system_config", private: true, auto_init: false });
    });

    it("treats 409 (already exists) as success", async () => {
      fetchMock.mockResolvedValueOnce(res(409, {}));
      const { ensureSystemConfigRepo } = await import("../gitea-admin.js");
      await expect(ensureSystemConfigRepo("acme")).resolves.toBeUndefined();
    });
  });

  describe("ensureProjectRepo", () => {
    it("creates the private project repo named after the project", async () => {
      fetchMock.mockResolvedValueOnce(res(201, {}));
      const { ensureProjectRepo } = await import("../gitea-admin.js");
      await ensureProjectRepo("acme", "mygame");

      const c = callsTo(fetchMock)[0];
      expect(c).toMatchObject({ url: `${BASE}/orgs/acme/repos`, method: "POST" });
      expect(c.body).toMatchObject({ name: "mygame", private: true, auto_init: false });
    });
  });

  describe("repoExists", () => {
    it("returns true on 200", async () => {
      fetchMock.mockResolvedValueOnce(res(200, { id: 1 }));
      const { repoExists } = await import("../gitea-admin.js");
      expect(await repoExists("acme", "workspace")).toBe(true);
      expect(callsTo(fetchMock)[0]).toMatchObject({ url: `${BASE}/repos/acme/workspace`, method: "GET" });
    });

    it("returns false on 404", async () => {
      fetchMock.mockResolvedValueOnce(res(404, {}));
      const { repoExists } = await import("../gitea-admin.js");
      expect(await repoExists("acme", "workspace")).toBe(false);
    });
  });

  describe("archiveRepo", () => {
    it("PATCHes archived:true", async () => {
      fetchMock.mockResolvedValueOnce(res(200, {}));
      const { archiveRepo } = await import("../gitea-admin.js");
      await archiveRepo("acme", "workspace");

      const c = callsTo(fetchMock)[0];
      expect(c).toMatchObject({ url: `${BASE}/repos/acme/workspace`, method: "PATCH" });
      expect(c.body).toMatchObject({ archived: true });
    });

    it("tolerates 404 (repo already gone) as a no-op", async () => {
      fetchMock.mockResolvedValueOnce(res(404, {}));
      const { archiveRepo } = await import("../gitea-admin.js");
      await expect(archiveRepo("acme", "workspace")).resolves.toBeUndefined();
    });
  });

  it("refuses to start a request when GITEA_TOKEN is unset", async () => {
    delete process.env.GITEA_TOKEN;
    vi.resetModules();
    const { repoExists } = await import("../gitea-admin.js");
    await expect(repoExists("acme", "workspace")).rejects.toThrow(/GITEA_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
