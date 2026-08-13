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
    const { giteaApi } = await import("../lib/gitea.js");
    await giteaApi("acme", "workspace/contents/README.md");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://gitea.test:3000/api/v1/repos/acme/workspace/contents/README.md",
    );
  });

  it("giteaApiAs threads the caller token and the workspace org", async () => {
    fetchMock.mockResolvedValueOnce(res(200, {}));
    const { giteaApiAs } = await import("../lib/gitea.js");
    await giteaApiAs("cust-tok", "alice", "my-game/contents/x");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gitea.test:3000/api/v1/repos/alice/my-game/contents/x");
    expect((init.headers as Record<string, string>).Authorization).toBe("token cust-tok");
  });

  it("createProjectGiteaRepo posts to /orgs/{org}/repos", async () => {
    fetchMock.mockResolvedValueOnce(res(201, {}));
    const { createProjectGiteaRepo } = await import("../lib/gitea.js");
    await expect(createProjectGiteaRepo("alice", "my-game", "desc", true)).resolves.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://gitea.test:3000/api/v1/orgs/alice/repos",
    );
  });

  it("reports that a 409 repo was not created by this attempt", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(res(409, { message: "already exists" }));
    const { createProjectGiteaRepo } = await import("../lib/gitea.js");
    await expect(createProjectGiteaRepo("alice", "my-game", "desc", true)).resolves.toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("giteaDeleteRepo deletes {org}/{repo}", async () => {
    fetchMock.mockResolvedValueOnce(res(204));
    const { giteaDeleteRepo } = await import("../lib/gitea.js");
    await giteaDeleteRepo("alice", "my-game");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gitea.test:3000/api/v1/repos/alice/my-game");
    expect(init.method).toBe("DELETE");
  });

  it("giteaDeleteVerifiedRepo checks the tenant binding before deletion and confirms absence after", async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { name: "my-game", owner: { login: "alice" } }))
      .mockResolvedValueOnce(res(204))
      .mockResolvedValueOnce(res(404));

    const { giteaDeleteVerifiedRepo } = await import("../lib/gitea.js");
    await giteaDeleteVerifiedRepo("alice", "my-game");

    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "DELETE", "GET"]);
  });

  it("giteaDeleteVerifiedRepo refuses a repo that is not bound to the expected tenant", async () => {
    fetchMock.mockResolvedValueOnce(res(200, { name: "my-game", owner: { login: "victim" } }));

    const { giteaDeleteVerifiedRepo } = await import("../lib/gitea.js");
    await expect(giteaDeleteVerifiedRepo("alice", "my-game")).rejects.toThrow(/binding mismatch/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not export a GITEA_ORG constant (no shared-org fallback)", async () => {
    const mod = await import("../lib/gitea.js");
    expect("GITEA_ORG" in mod).toBe(false);
  });

  it("giteaWriteFiles probes each path, then batch-creates only the absent ones in one commit", async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, { path: "README.md" }))
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(201, {}));

    const { giteaWriteFiles } = await import("../lib/gitea.js");
    await giteaWriteFiles(
      "alice",
      "my-game",
      [
        { path: "README.md", content: "# already here" },
        { path: "DECISIONS.md", content: "# Decisions\n" },
        { path: "runbook/how-we-build.md", content: "# How\n" },
      ],
      "auto: seed project playbook",
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://gitea.test:3000/api/v1/repos/alice/my-game/contents/README.md",
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "http://gitea.test:3000/api/v1/repos/alice/my-game/contents/runbook/how-we-build.md",
    );

    const [url, init] = fetchMock.mock.calls[3];
    expect(url).toBe("http://gitea.test:3000/api/v1/repos/alice/my-game/contents");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body.message).toBe("auto: seed project playbook");
    expect(body.branch).toBe("main");
    expect(body.files).toEqual([
      {
        operation: "create",
        path: "DECISIONS.md",
        content: Buffer.from("# Decisions\n", "utf-8").toString("base64"),
      },
      {
        operation: "create",
        path: "runbook/how-we-build.md",
        content: Buffer.from("# How\n", "utf-8").toString("base64"),
      },
    ]);
  });

  it("giteaWriteFiles issues no commit when every file already exists (retry is a no-op)", async () => {
    // A fresh Response per call: one instance cannot have its body read twice.
    fetchMock.mockImplementation(() => Promise.resolve(res(200, { path: "x" })));

    const { giteaWriteFiles } = await import("../lib/gitea.js");
    await giteaWriteFiles(
      "alice",
      "my-game",
      [
        { path: "DECISIONS.md", content: "a" },
        { path: "notes/welcome.md", content: "b" },
      ],
      "auto: seed project playbook",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.method).toBe("GET");
    }
  });

  it("keeps a seed group all-or-none when an existing package file is present", async () => {
    fetchMock
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(200, { path: "package-lock.json" }));

    const { giteaWriteFilesIfAllAbsent } = await import("../lib/gitea.js");
    await giteaWriteFilesIfAllAbsent(
      "alice",
      "my-game",
      [
        { path: "package.json", content: "new manifest" },
        { path: "package-lock.json", content: "new lock" },
      ],
      "auto: seed project starter",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.method).toBe("GET");
    }
  });

  it("batch-creates an all-absent seed group", async () => {
    fetchMock
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(201, {}));

    const { giteaWriteFilesIfAllAbsent } = await import("../lib/gitea.js");
    await giteaWriteFilesIfAllAbsent(
      "alice",
      "my-game",
      [
        { path: "package.json", content: "new manifest" },
        { path: "package-lock.json", content: "new lock" },
      ],
      "auto: seed project starter",
    );

    const [, init] = fetchMock.mock.calls[2];
    const body = JSON.parse(init.body as string);
    expect(body.files).toEqual([
      {
        operation: "create",
        path: "package.json",
        content: Buffer.from("new manifest", "utf-8").toString("base64"),
      },
      {
        operation: "create",
        path: "package-lock.json",
        content: Buffer.from("new lock", "utf-8").toString("base64"),
      },
    ]);
  });

  it("giteaWriteFiles throws when the batch commit is rejected — seeds are not best-effort", async () => {
    fetchMock
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(422, { message: "already exists" }));

    const { giteaWriteFiles } = await import("../lib/gitea.js");
    await expect(
      giteaWriteFiles("alice", "my-game", [{ path: "DECISIONS.md", content: "a" }], "auto: seed"),
    ).rejects.toThrow(/422/);
  });
});
