import { describe, it, expect, vi } from "vitest";
import { nukeUserCloudSide, type NukeCloudCtx, type NukeCloudDeps } from "../lib/customer-ops/nuke-cloud";

function mkCtx(overrides: Partial<NukeCloudCtx> = {}): NukeCloudCtx {
  return {
    uid: "uid-alice",
    slug: "alice",
    email: "alice@example.com",
    giteaOrg: "alice",
    repoNames: ["workspace", "blog"],
    projectSlugs: ["blog"],
    workspaceTeamId: "team-1",
    mmUserId: "mm-u-1",
    mmCoachUserId: "mm-coach-1",
    adminChannelId: "mm-c-admin",
    ...overrides,
  };
}

function mkDeps(overrides: Partial<NukeCloudDeps> = {}): NukeCloudDeps {
  return {
    gitea: {
      deleteRepo: vi.fn(async () => undefined),
      deleteOrg: vi.fn(async () => undefined),
      deleteGiteaUser: vi.fn(async () => undefined),
    },
    mattermost: {
      destroyUser: vi.fn(async () => undefined),
      destroyChannel: vi.fn(async () => undefined),
      destroyTeam: vi.fn(async () => undefined),
      getUserChannels: vi.fn(async () => ["mm-c-1", "mm-c-2"]),
    },
    nukeUserFirestore: vi.fn(async () => undefined),
    nukeWsTickets: vi.fn(async () => ({ deleted: 3 })),
    deleteAvatar: vi.fn(async () => undefined),
    deleteAuthUser: vi.fn(async () => undefined),
    log: vi.fn(),
    ...overrides,
  };
}

describe("nukeUserCloudSide — happy path", () => {
  it("runs all six steps and reports each as ok", async () => {
    const deps = mkDeps();
    const results = await nukeUserCloudSide(mkCtx(), deps);
    expect(results.map((r) => `${r.key}:${r.ok}`)).toEqual([
      "gitea:true",
      "mattermost:true",
      "firestore:true",
      "storage:true",
      "hosting:true",
      "auth:true",
    ]);
    
    expect(results.find((r) => r.key === "hosting")?.skipped).toBe(true);
  });

  it("Gitea step deletes every repo + the user", async () => {
    const deps = mkDeps();
    await nukeUserCloudSide(mkCtx(), deps);
    expect(deps.gitea.deleteRepo).toHaveBeenCalledTimes(2);
    expect(deps.gitea.deleteRepo).toHaveBeenCalledWith("alice", "workspace");
    expect(deps.gitea.deleteRepo).toHaveBeenCalledWith("alice", "blog");
    expect(deps.gitea.deleteOrg).toHaveBeenCalledWith("alice");
    expect(deps.gitea.deleteGiteaUser).toHaveBeenCalledWith("alice");
  });

  it("MM step destroys all user channels then the user, plus admin channel + coach + team", async () => {
    const deps = mkDeps();
    await nukeUserCloudSide(mkCtx(), deps);
    expect(deps.mattermost.getUserChannels).toHaveBeenCalledWith("mm-u-1", "team-1");
    expect(deps.mattermost.destroyChannel).toHaveBeenCalledWith("mm-c-1");
    expect(deps.mattermost.destroyChannel).toHaveBeenCalledWith("mm-c-2");
    expect(deps.mattermost.destroyChannel).toHaveBeenCalledWith("mm-c-admin");
    expect(deps.mattermost.destroyUser).toHaveBeenCalledWith("mm-u-1");
    expect(deps.mattermost.destroyUser).toHaveBeenCalledWith("mm-coach-1");
    expect(deps.mattermost.destroyTeam).toHaveBeenCalledWith("team-1");
  });

  it("MM step gracefully handles missing IDs (raw signup with no MM bootstrap)", async () => {
    const deps = mkDeps();
    await nukeUserCloudSide(
      mkCtx({
        workspaceTeamId: null,
        mmUserId: null,
        mmCoachUserId: null,
        adminChannelId: null,
      }),
      deps,
    );
    expect(deps.mattermost.destroyUser).not.toHaveBeenCalled();
    expect(deps.mattermost.destroyTeam).not.toHaveBeenCalled();
    expect(deps.mattermost.destroyChannel).not.toHaveBeenCalled();
  });
});

describe("nukeUserCloudSide — partial failure", () => {
  it("continues subsequent steps when one fails; reports per-step error", async () => {
    const deps = mkDeps({
      gitea: {
        deleteRepo: vi.fn(async () => {
          throw new Error("gitea down");
        }),
        deleteGiteaUser: vi.fn(),
      },
    });
    const results = await nukeUserCloudSide(mkCtx(), deps);
    const gitea = results.find((r) => r.key === "gitea");
    expect(gitea?.ok).toBe(false);
    expect(gitea?.error).toMatch(/gitea down/);
    
    expect(deps.nukeUserFirestore).toHaveBeenCalled();
  });

  it("auth step error doesn't block the orchestrator from completing", async () => {
    const deps = mkDeps({
      deleteAuthUser: vi.fn(async () => {
        throw new Error("auth/unknown-error");
      }),
    });
    const results = await nukeUserCloudSide(mkCtx(), deps);
    expect(results.find((r) => r.key === "auth")?.ok).toBe(false);
    expect(results).toHaveLength(6);
  });
});

describe("nukeUserCloudSide — skip flags", () => {
  it("skipAuth marks the step skipped without calling deleteAuthUser", async () => {
    const deps = mkDeps();
    const results = await nukeUserCloudSide(mkCtx({ skipAuth: true }), deps);
    expect(results.find((r) => r.key === "auth")).toMatchObject({ ok: true, skipped: true });
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });

  it("skipHosting + missing deleteHostingSites both yield a skipped hosting step", async () => {
    const deps = mkDeps();
    const results = await nukeUserCloudSide(mkCtx({ skipHosting: true }), deps);
    expect(results.find((r) => r.key === "hosting")).toMatchObject({ ok: true, skipped: true });
  });
});

describe("nukeUserCloudSide — hosting step (PR #3)", () => {
  it("calls deleteHostingSites with ctx.slug + ctx.projectSlugs (no regex extraction)", async () => {
    const deleteHostingSites = vi.fn(async () => ({ deleted: 2 }));
    const deps = mkDeps({ deleteHostingSites });
    await nukeUserCloudSide(
      mkCtx({ projectSlugs: ["blog", "shop"] }),
      deps,
    );
    expect(deleteHostingSites).toHaveBeenCalledTimes(1);
    expect(deleteHostingSites).toHaveBeenCalledWith("alice", ["blog", "shop"]);
  });

  it("hosting step is reported as ok when deleteHostingSites resolves", async () => {
    const deleteHostingSites = vi.fn(async () => ({ deleted: 0 }));
    const deps = mkDeps({ deleteHostingSites });
    const results = await nukeUserCloudSide(mkCtx({ projectSlugs: [] }), deps);
    expect(results.find((r) => r.key === "hosting")).toMatchObject({ ok: true });
  });

  it("hosting step is reported as failed when deleteHostingSites throws", async () => {
    const deleteHostingSites = vi.fn(async () => {
      throw new Error("hosting boom");
    });
    const deps = mkDeps({ deleteHostingSites });
    const results = await nukeUserCloudSide(
      mkCtx({ projectSlugs: ["one"] }),
      deps,
    );
    expect(results.find((r) => r.key === "hosting")).toMatchObject({
      ok: false,
      error: expect.stringContaining("hosting boom"),
    });
  });

  it("does NOT extract projectSlugs from repoNames anymore (regression: the old slice produced 'proj-<slug>' instead of '<slug>')", async () => {
    const deleteHostingSites = vi.fn(async () => ({ deleted: 1 }));
    const deps = mkDeps({ deleteHostingSites });

await nukeUserCloudSide(
      mkCtx({
        repoNames: ["workspace", "blog"],
        projectSlugs: ["blog"],
      }),
      deps,
    );
    expect(deleteHostingSites).toHaveBeenCalledWith("alice", ["blog"]);
    const args = deleteHostingSites.mock.calls[0]![1] as string[];
    expect(args).not.toContain("proj-blog");
  });
});

describe("nukeUserCloudSide — wsTickets cleanup", () => {
  it("calls nukeWsTickets after subtree delete", async () => {
    const deps = mkDeps();
    await nukeUserCloudSide(mkCtx(), deps);
    expect(deps.nukeUserFirestore).toHaveBeenCalledWith("uid-alice");
    expect(deps.nukeWsTickets).toHaveBeenCalledWith("uid-alice");
  });
});
