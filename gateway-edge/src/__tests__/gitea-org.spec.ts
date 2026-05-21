import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const OLD_ENV = { ...process.env };

function res(status: number, body: unknown = {}): Response {
  const noBody = status === 204 || status === 304;
  return new Response(noBody ? null : JSON.stringify(body), { status });
}

describe("gateway-edge gitea client — per-workspace org", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.GITEA_URL = "http://gitea.test:3000";
    process.env.GITEA_TOKEN = "admin-tok";
    process.env.K8S_NAMESPACE = "octogee";
    delete process.env.GITEA_ORG;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...OLD_ENV };
  });

  it("giteaApi targets /repos/{org}/{path} — org is an explicit arg, not GITEA_ORG", async () => {
    fetchMock.mockResolvedValueOnce(res(200, { ok: true }));
    const { giteaApi } = await import("../lib/gitea");
    await giteaApi("acme", "workspace/contents/README.md");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://gitea.test:3000/api/v1/repos/acme/workspace/contents/README.md",
    );
  });

  it("giteaApiAs threads the caller token and the workspace org", async () => {
    fetchMock.mockResolvedValueOnce(res(200, {}));
    const { giteaApiAs } = await import("../lib/gitea");
    await giteaApiAs("cust-tok", "alice", "my-game/contents/x");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gitea.test:3000/api/v1/repos/alice/my-game/contents/x");
    expect((init.headers as Record<string, string>).Authorization).toBe("token cust-tok");
  });

  it("createProjectGiteaRepo posts to /orgs/{org}/repos", async () => {
    fetchMock.mockResolvedValueOnce(res(201, {}));
    const { createProjectGiteaRepo } = await import("../lib/gitea");
    await createProjectGiteaRepo("alice", "my-game", "desc", true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://gitea.test:3000/api/v1/orgs/alice/repos",
    );
  });

  it("giteaDeleteRepo deletes {org}/{repo}", async () => {
    fetchMock.mockResolvedValueOnce(res(204));
    const { giteaDeleteRepo } = await import("../lib/gitea");
    await giteaDeleteRepo("alice", "my-game");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gitea.test:3000/api/v1/repos/alice/my-game");
    expect(init.method).toBe("DELETE");
  });

  it("does not export a GITEA_ORG constant (no shared-org fallback)", async () => {
    const mod = await import("../lib/gitea");
    expect("GITEA_ORG" in mod).toBe(false);
  });
});
