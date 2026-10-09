import { describe, it, expect, vi } from "vitest";
import { nukeUserCloudSide, type NukeCloudCtx, type NukeCloudDeps } from "../lib/customer-ops/nuke-cloud";

function mkCtx(overrides: Partial<NukeCloudCtx> = {}): NukeCloudCtx {
  return {
    uid: "uid-alice",
    currentOperationId: "erase-1",
    slug: "alice",
    email: "alice@example.com",
    giteaOrg: "alice",
    repoNames: ["workspace", "blog"],
    projectSlugs: ["blog"],
    workspaceTeamId: "team-1",
    mmUserId: "mm-u-1",
    mmCoachUserId: "mm-coach-1",
    adminChannelId: "mm-c-admin",
    credentialSecretNames: [],
    projectAgentMmUserIds: ["mm-project-1", "mm-project-2"],
    projectAgentCredentialDocPaths: [
      "users/uid-alice/secrets/projectAgentMattermost-blog",
    ],
    chatArtifactIds: ["a".repeat(64)],
    agentImportIds: ["import-1"],
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
      userExists: vi.fn(async () => false),
    },
    nukeUserFirestore: vi.fn(async () => undefined),
    deleteCustomerStorage: vi.fn(async () => undefined),
    deleteHostingSites: vi.fn(async () => ({ deleted: 0 })),
    deleteCredentialSecrets: vi.fn(async () => undefined),
    deleteAuthUser: vi.fn(async () => undefined),
    deleteComputer: vi.fn(async () => true),
    deleteComputerHome: vi.fn(async () => ({ deleted: 2 })),
    log: vi.fn(),
    ...overrides,
  };
}

describe("nukeUserCloudSide — happy path", () => {
  it("runs all nine erasure steps and reports each as ok", async () => {
    const deps = mkDeps();
    const results = await nukeUserCloudSide(mkCtx(), deps);
    expect(results.map((r) => `${r.key}:${r.ok}`)).toEqual([
      "gitea:true",
      "mattermost:true",
      "storage:true",
      "hosting:true",
      "credentials:true",
      "computer:true",
      "computer-home:true",
      "firestore:true",
      "auth:true",
    ]);
    expect(deps.deleteComputer).toHaveBeenCalledWith("uid-alice");
    expect(results.find((r) => r.key === "hosting")).toMatchObject({ ok: true });
  });

  it("sweeps the home checkpoints only after the computer is gone and journals the object count", async () => {
    const deps = mkDeps();
    const results = await nukeUserCloudSide(mkCtx(), deps);
    expect(deps.deleteComputerHome).toHaveBeenCalledWith("uid-alice", "alice");
    expect(vi.mocked(deps.deleteComputer!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.deleteComputerHome).mock.invocationCallOrder[0],
    );
    expect(results.find((r) => r.key === "computer-home")).toEqual({
      key: "computer-home",
      ok: true,
      detail: "2 objects",
    });
  });

  it("still sweeps the home checkpoints on a pod-only fleet, and skips only without a slug", async () => {
    const podOnly = mkDeps({ deleteComputer: undefined });
    await nukeUserCloudSide(mkCtx(), podOnly);
    expect(podOnly.deleteComputerHome).toHaveBeenCalledWith("uid-alice", "alice");

    const unprovisioned = mkDeps();
    const results = await nukeUserCloudSide(mkCtx({ slug: "" }), unprovisioned);
    expect(unprovisioned.deleteComputerHome).not.toHaveBeenCalled();
    expect(results.find((r) => r.key === "computer-home")).toEqual({ key: "computer-home", ok: true, skipped: true });
  });

  it("fails the computer-home step loudly and blocks auth deletion when the sweep fails", async () => {
    const deps = mkDeps({ deleteComputerHome: vi.fn(async () => { throw new Error("storage 403"); }) });
    const results = await nukeUserCloudSide(mkCtx(), deps);
    expect(results.find((r) => r.key === "computer-home")).toEqual({ key: "computer-home", ok: false, error: "storage 403" });
    expect(results.find((r) => r.key === "auth")).toEqual({ key: "auth", ok: true, skipped: true });
    expect(deps.nukeUserFirestore).not.toHaveBeenCalled();
  });

  it("skips the computer step on a pod-only fleet and blocks auth deletion when the computer survives", async () => {
    const podOnly = await nukeUserCloudSide(mkCtx(), mkDeps({ deleteComputer: undefined }));
    expect(podOnly.find((r) => r.key === "computer")).toEqual({ key: "computer", ok: true, skipped: true });

    const stuck = await nukeUserCloudSide(mkCtx(), mkDeps({ deleteComputer: vi.fn(async () => { throw new Error("compute 403"); }) }));
    expect(stuck.find((r) => r.key === "computer")).toMatchObject({ ok: false, error: "compute 403" });
    expect(stuck.find((r) => r.key === "auth")).toEqual({ key: "auth", ok: true, skipped: true });
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
    expect(deps.mattermost.destroyUser).toHaveBeenCalledWith("mm-project-1");
    expect(deps.mattermost.destroyUser).toHaveBeenCalledWith("mm-project-2");
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
        projectAgentMmUserIds: [],
      }),
      deps,
    );
    expect(deps.mattermost.destroyUser).not.toHaveBeenCalled();
    expect(deps.mattermost.destroyTeam).not.toHaveBeenCalled();
    expect(deps.mattermost.destroyChannel).not.toHaveBeenCalled();
  });

  it("permanently deletes a known Mattermost user even when the workspace team is already gone", async () => {
    const deps = mkDeps();
    await nukeUserCloudSide(
      mkCtx({ workspaceTeamId: null, mmUserId: "mm-u-orphan" }),
      deps,
    );
    expect(deps.mattermost.getUserChannels).not.toHaveBeenCalled();
    expect(deps.mattermost.destroyUser).toHaveBeenCalledWith("mm-u-orphan");
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
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
    expect(results.find((r) => r.key === "auth")).toMatchObject({
      ok: true,
      skipped: true,
    });
  });

  it("auth step error doesn't block the orchestrator from completing", async () => {
    const deps = mkDeps({
      deleteAuthUser: vi.fn(async () => {
        throw new Error("auth/unknown-error");
      }),
    });
    const results = await nukeUserCloudSide(mkCtx(), deps);
    expect(results.find((r) => r.key === "auth")?.ok).toBe(false);
    expect(results).toHaveLength(9);
  });
});

describe("nukeUserCloudSide — skip flags", () => {
  it("skipAuth marks the step skipped without calling deleteAuthUser", async () => {
    const deps = mkDeps();
    const results = await nukeUserCloudSide(mkCtx({ skipAuth: true }), deps);
    expect(results.find((r) => r.key === "auth")).toMatchObject({ ok: true, skipped: true });
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
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
    expect(results.find((r) => r.key === "firestore")).toMatchObject({
      ok: true,
      skipped: true,
    });
    expect(deps.nukeUserFirestore).not.toHaveBeenCalled();
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

describe("nukeUserCloudSide — firestore step", () => {
  it("passes uid AND slug so the workspace + agent docs get deleted, not just the user subtree", async () => {
    const deps = mkDeps();
    await nukeUserCloudSide(mkCtx(), deps);
    expect(deps.nukeUserFirestore).toHaveBeenCalledWith(
      "uid-alice",
      "alice",
      "alice@example.com",
      "erase-1",
    );
  });

  it("deletes all customer storage prefixes and credential secrets before Firestore", async () => {
    const order: string[] = [];
    const deps = mkDeps({
      deleteCustomerStorage: vi.fn(async () => { order.push("storage"); }),
      deleteCredentialSecrets: vi.fn(async () => { order.push("credentials"); }),
      nukeUserFirestore: vi.fn(async () => { order.push("firestore"); }),
    });
    await nukeUserCloudSide(mkCtx({ credentialSecretNames: ["byosub-1"] }), deps);
    expect(deps.deleteCustomerStorage).toHaveBeenCalledWith(
      "uid-alice",
      "alice",
      ["a".repeat(64)],
      ["import-1"],
    );
    expect(deps.deleteCredentialSecrets).toHaveBeenCalledWith(["byosub-1"]);
    expect(order).toEqual(["storage", "credentials", "firestore"]);
  });
});
