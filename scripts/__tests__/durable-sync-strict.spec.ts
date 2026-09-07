import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const noopManifestStore = () => ({
  read: async () => null,
  write: async () => {},
});

const paths = vi.hoisted(() => ({
  root: `/tmp/octogee-durable-sync-${process.pid}`,
  customers: `/tmp/octogee-durable-sync-${process.pid}/customers`,
  keys: `/tmp/octogee-durable-sync-${process.pid}/keys`,
}));

vi.mock("../lib/config.js", () => ({
  log: vi.fn(),
  dlog: vi.fn(),
  GIT_API_URL: "https://gitea.test/api/v1",
  GIT_SSH_HOST: "gitea.test",
  OPENCLAW_DIR: paths.root,
  CUSTOMERS_DIR: paths.customers,
  CUSTOMER_KEYS_DIR: paths.keys,
  AGENTS_DIR: "/tmp/octogee-test/agents",
  BLOB_SYNC_MAX_CONCURRENT: 2,
  BLOB_SYNC_MAX_SIZE: 100 * 1024 * 1024,
}));

const {
  externalizeCustomerGitDir,
  reconcileImportedWorkspace,
  retryAllCustomerRepositoryPushes,
  syncAllCustomerRepositories,
  syncAllWorkspaces,
  syncCustomerRepositoriesForSlug,
} = await import("../lib/git.js");
const { blobSyncAllWithOptions, blobSyncForSlug } = await import("../lib/blob-sync.js");
const { workspaceGitignore } = await import("../lib/git.js");

beforeEach(() => {
  fs.rmSync(paths.root, { recursive: true, force: true });
  fs.mkdirSync(paths.customers, { recursive: true });
  fs.mkdirSync(paths.keys, { recursive: true });
});

afterEach(() => {
  fs.rmSync(paths.root, { recursive: true, force: true });
});

describe("strict durable sync", () => {
  const testGitExec = (cwd: string, argv: string[]): string | null => {
    try {
      return execFileSync("git", argv, { cwd, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  const prepareTestRepository = (repoDir: string): void => {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
    const gitDir = externalizeCustomerGitDir(repoDir, {
      fetchCanonical: (_worktree, freshGitDir) => {
        if (!fs.existsSync(remote)) return;
        execFileSync("git", [
          "--git-dir", freshGitDir,
          "fetch", remote,
          "+refs/heads/*:refs/remotes/origin/*",
        ]);
      },
    });
    if (!gitDir) throw new Error(`missing customer identity for ${repoDir}`);
    execFileSync("git", ["config", "--file", path.join(gitDir, "config"), "remote.origin.url", remote]);
  };

  function initPushableRepo(repo: string, remote: string): void {
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(remote, { recursive: true });
    // -b main: a bare repo without it inherits the host's default initial branch,
    // so on a runner that still defaults to master a clone of this remote lands on
    // an unborn master and can never push main.
    execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@octogee.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
    prepareTestRepository(repo);
  }

  it("rejects an unexternalized customer repository before its preparer can run", async () => {
    const workspace = path.join(paths.customers, "alice");
    fs.mkdirSync(workspace, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    const prepareRepository = vi.fn(prepareTestRepository);

    await expect(syncCustomerRepositoriesForSlug("alice", {
      strict: true,
      gitExec: testGitExec,
      prepareRepository,
    })).rejects.toThrow(/workspace git metadata is missing/u);

    expect(prepareRepository).not.toHaveBeenCalled();
  });

  it("strictly commits and pushes one customer's workspace and every project repo", async () => {
    const customer = path.join(paths.customers, "alice");
    const project = path.join(customer, "projects", "launch");
    const remotes = path.join(paths.customers, "remotes");
    const workspaceRemote = path.join(remotes, "workspace.git");
    const projectRemote = path.join(remotes, "project.git");
    initPushableRepo(customer, workspaceRemote);
    initPushableRepo(project, projectRemote);
    fs.writeFileSync(path.join(customer, ".gitignore"), "projects/\n");
    fs.writeFileSync(path.join(customer, "README.md"), "workspace checkpoint\n");
    fs.writeFileSync(path.join(project, "README.md"), "project checkpoint\n");

    await syncCustomerRepositoriesForSlug("alice", {
      strict: true,
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    });

    expect(execFileSync("git", ["status", "--porcelain"], { cwd: customer, encoding: "utf8" })).toBe("");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" })).toBe("");
    expect(execFileSync("git", ["show", "main:README.md"], { cwd: workspaceRemote, encoding: "utf8" })).toBe("workspace checkpoint\n");
    expect(execFileSync("git", ["show", "main:README.md"], { cwd: projectRemote, encoding: "utf8" })).toBe("project checkpoint\n");
  });

  it("refuses to autosave a workspace binary into a Gitea repository", async () => {
    const customer = path.join(paths.customers, "alice");
    const remote = path.join(paths.customers, "remotes", "workspace.git");
    initPushableRepo(customer, remote);
    fs.writeFileSync(path.join(customer, ".gitignore"), `${workspaceGitignore()}\n`);
    const binary = Buffer.from([0x89, 0x50, 0x00, 0x47]);
    fs.writeFileSync(path.join(customer, "cover.png"), binary);

    await expect(syncCustomerRepositoriesForSlug("alice", {
      strict: true,
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    })).rejects.toThrow(/alice: binary files require workspace_commit/u);

    expect(fs.readFileSync(path.join(customer, "cover.png"))).toEqual(binary);
    expect(testGitExec(remote, ["show", "main:cover.png"])).toBeNull();
  });

  it("refuses to autosave a project binary into a Gitea repository", async () => {
    const customer = path.join(paths.customers, "alice");
    const project = path.join(customer, "projects", "launch");
    const remotes = path.join(paths.customers, "remotes");
    initPushableRepo(customer, path.join(remotes, "workspace.git"));
    initPushableRepo(project, path.join(remotes, "project.git"));
    fs.writeFileSync(path.join(customer, ".gitignore"), "projects/\n");
    fs.writeFileSync(path.join(project, "cover.png"), Buffer.from([0x89, 0x50, 0x00]));

    await expect(syncCustomerRepositoriesForSlug("alice", {
      strict: true,
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    })).rejects.toThrow(/alice\/projects\/launch: binary files require workspace_commit/u);

    expect(fs.existsSync(path.join(project, "cover.png"))).toBe(true);
    expect(testGitExec(path.join(remotes, "project.git"), ["show", "main:cover.png"])).toBeNull();
  });

  it("rejects a strict durable flush when a project checkout is behind canonical origin", async () => {
    const customer = path.join(paths.customers, "alice");
    const project = path.join(customer, "projects", "launch");
    const remotes = path.join(paths.customers, "remotes");
    const projectRemote = path.join(remotes, "project.git");
    initPushableRepo(customer, path.join(remotes, "workspace.git"));
    initPushableRepo(project, projectRemote);
    fs.writeFileSync(path.join(customer, ".gitignore"), "projects/\n");
    fs.writeFileSync(path.join(customer, "README.md"), "workspace checkpoint\n");
    fs.writeFileSync(path.join(project, "README.md"), "project checkpoint\n");

    await syncCustomerRepositoriesForSlug("alice", {
      strict: true,
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    });

    const sibling = path.join(paths.root, "project-sibling");
    execFileSync("git", ["clone", "-q", projectRemote, sibling]);
    execFileSync("git", ["config", "user.email", "test@octogee.test"], { cwd: sibling });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: sibling });
    fs.writeFileSync(path.join(sibling, "REMOTE.md"), "canonical checkpoint\n");
    execFileSync("git", ["add", "-A"], { cwd: sibling });
    execFileSync("git", ["commit", "-q", "-m", "canonical checkpoint"], { cwd: sibling });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: sibling });

    await expect(syncCustomerRepositoriesForSlug("alice", {
      strict: true,
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    })).rejects.toThrow(/alice\/projects\/launch.*push/u);

    expect(testGitExec(project, ["rev-parse", "HEAD"]))
      .not.toBe(testGitExec(projectRemote, ["rev-parse", "main"]));
  });

  it("attempts every project checkpoint before reporting a workspace push failure", async () => {
    const customer = path.join(paths.customers, "alice");
    const project = path.join(customer, "projects", "launch");
    const projectRemote = path.join(paths.customers, "project.git");
    initPushableRepo(customer, path.join(paths.customers, "missing-workspace.git"));
    fs.rmSync(path.join(paths.customers, "missing-workspace.git"), { recursive: true, force: true });
    initPushableRepo(project, projectRemote);
    fs.writeFileSync(path.join(customer, ".gitignore"), "projects/\n");
    fs.writeFileSync(path.join(customer, "README.md"), "workspace checkpoint\n");
    fs.writeFileSync(path.join(project, "README.md"), "project checkpoint\n");

    await expect(syncCustomerRepositoriesForSlug("alice", {
      strict: true,
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    }))
      .rejects.toThrow(/alice.*push/u);

    expect(execFileSync("git", ["show", "main:README.md"], {
      cwd: projectRemote,
      encoding: "utf8",
    })).toBe("project checkpoint\n");
  });

  it("retries a project push that failed after the local checkpoint committed", async () => {
    const customer = path.join(paths.customers, "alice");
    const project = path.join(customer, "projects", "launch");
    const remote = path.join(paths.root, "remotes", "project.git");
    initPushableRepo(customer, path.join(paths.root, "remotes", "workspace.git"));
    initPushableRepo(project, remote);
    fs.writeFileSync(path.join(customer, ".gitignore"), "projects/\n");
    fs.writeFileSync(path.join(project, "README.md"), "recoverable project checkpoint\n");
    let failFirstPush = true;
    const flakyGitExec = (cwd: string, argv: string[]): string | null => {
      if (cwd === project && argv[0] === "push" && failFirstPush) {
        failFirstPush = false;
        return null;
      }
      return testGitExec(cwd, argv);
    };

    await syncAllCustomerRepositories({
      gitExec: flakyGitExec,
      prepareRepository: prepareTestRepository,
    });
    expect(testGitExec(remote, ["rev-parse", "refs/heads/main"])).toBeNull();

    await retryAllCustomerRepositoryPushes({
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    });

    expect(execFileSync("git", ["show", "main:README.md"], {
      cwd: remote,
      encoding: "utf8",
    })).toBe("recoverable project checkpoint\n");
  });

  it("does not commit in-progress work during push recovery", async () => {
    const customer = path.join(paths.customers, "alice");
    const project = path.join(customer, "projects", "launch");
    const remote = path.join(paths.root, "remotes", "project.git");
    initPushableRepo(project, remote);
    fs.writeFileSync(path.join(project, "README.md"), "committed checkpoint\n");
    execFileSync("git", ["add", "README.md"], { cwd: project });
    execFileSync("git", ["commit", "-q", "-m", "existing checkpoint"], { cwd: project });
    fs.writeFileSync(path.join(project, "IN_PROGRESS.md"), "do not commit\n");

    await retryAllCustomerRepositoryPushes({
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    });

    expect(execFileSync("git", ["show", "main:README.md"], {
      cwd: remote,
      encoding: "utf8",
    })).toBe("committed checkpoint\n");
    expect(execFileSync("git", ["status", "--porcelain"], {
      cwd: project,
      encoding: "utf8",
    })).toBe("?? IN_PROGRESS.md\n");
  });

  it("a slug-scoped migration blob flush does not touch another customer", async () => {
    for (const slug of ["alice", "bob"]) {
      const customer = path.join(paths.customers, slug);
      fs.mkdirSync(path.join(customer, ".files"), { recursive: true });
      fs.mkdirSync(path.join(customer, ".blobs"), { recursive: true });
      fs.writeFileSync(path.join(customer, ".files", "manifest.json"), "{}\n");
      fs.writeFileSync(path.join(customer, ".blobs", "pending.txt"), `${slug}\n`);
    }
    const upload = vi.fn(async () => {});

    await blobSyncForSlug("alice", {
      strict: true,
      store: { manifestFor: noopManifestStore, download: vi.fn(async () => {}), upload },
    });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ slug: "alice" }));
    expect(fs.readFileSync(
      path.join(paths.customers, "bob", ".files", "manifest.json"),
      "utf8",
    )).toBe("{}\n");
  });

  it("rejects the final workspace flush when a real git push fails", async () => {
    const workspace = path.join(paths.customers, "alice");
    fs.mkdirSync(workspace, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "test@octogee.test"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "README.md"), "durable\n");
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    execFileSync("git", ["commit", "-q", "-m", "local state"], { cwd: workspace });
    execFileSync("git", ["remote", "add", "origin", path.join(paths.customers, "missing.git")], {
      cwd: workspace,
    });
    prepareTestRepository(workspace);

    await expect(syncAllWorkspaces({
      strict: true,
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    })).rejects.toThrow(/alice.*push/i);
  });

  it("rejects the final blob flush when a per-customer upload fails", async () => {
    const customer = path.join(paths.customers, "alice");
    fs.mkdirSync(path.join(customer, ".files"), { recursive: true });
    fs.mkdirSync(path.join(customer, ".blobs"), { recursive: true });
    fs.writeFileSync(path.join(customer, ".files", "manifest.json"), "{}\n");
    fs.writeFileSync(path.join(customer, ".blobs", "pending.txt"), "not uploaded\n");

    await expect(blobSyncAllWithOptions({
      strict: true,
      storeForSlug: () => ({
        manifestFor: noopManifestStore,
        download: vi.fn(async () => {}),
        upload: vi.fn(async () => { throw new Error("storage unavailable"); }),
      }),
    })).rejects.toThrow(/alice.*storage unavailable/i);
  });
});

describe("workspace divergence", () => {
  const testGitExec = (cwd: string, argv: string[]): string | null => {
    try {
      return execFileSync("git", argv, { cwd, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  const prepareTestRepository = (repoDir: string): void => {
    const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
    const gitDir = externalizeCustomerGitDir(repoDir, {
      fetchCanonical: (_worktree, freshGitDir) => {
        if (!fs.existsSync(remote)) return;
        execFileSync("git", [
          "--git-dir", freshGitDir,
          "fetch", remote,
          "+refs/heads/*:refs/remotes/origin/*",
        ]);
      },
    });
    if (!gitDir) throw new Error(`missing customer identity for ${repoDir}`);
    execFileSync("git", ["config", "--file", path.join(gitDir, "config"), "remote.origin.url", remote]);
  };

  function initWorkspaceWithRemote(slug: string): { workspace: string; remote: string } {
    const workspace = path.join(paths.customers, slug);
    const remote = path.join(paths.root, "remotes", `${slug}.git`);
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(remote, { recursive: true });
    // -b main: a bare repo without it inherits the host's default initial branch,
    // so on a runner that still defaults to master a clone of this remote lands on
    // an unborn master and can never push main.
    execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remote });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "test@octogee.test"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "README.md"), "shared base\n");
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    execFileSync("git", ["commit", "-q", "-m", "shared base"], { cwd: workspace });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: workspace });
    prepareTestRepository(workspace);
    return { workspace, remote };
  }

  function commitLocally(repo: string, file: string, body: string): void {
    fs.writeFileSync(path.join(repo, file), body);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", `auto: ${file}`], { cwd: repo });
  }

  // A second pod pushing the same workspace is what forks it — the remote gains a
  // commit this worktree will never contain.
  function advanceRemoteFromASibling(slug: string, remote: string): void {
    const sibling = path.join(paths.root, `sibling-${slug}`);
    execFileSync("git", ["clone", "-q", remote, sibling]);
    execFileSync("git", ["config", "user.email", "test@octogee.test"], { cwd: sibling });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: sibling });
    commitLocally(sibling, "SIBLING.md", "written by the other pod\n");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: sibling });
  }

  it("skips the import reconcile while the workspace git dir is not on disk yet", () => {
    const { workspace } = initWorkspaceWithRemote("alice");
    const pointer = fs.readFileSync(path.join(workspace, ".git"), "utf8");
    expect(pointer).toContain("gitdir:");
    // The import stages the worktree — pointer file and all — before activation
    // recreates the git dir it points at.
    const metadataDir = pointer.replace("gitdir:", "").trim();
    fs.rmSync(metadataDir, { recursive: true, force: true });

    expect(() => reconcileImportedWorkspace("alice", { gitExec: testGitExec })).not.toThrow();
    expect(reconcileImportedWorkspace("alice", { gitExec: testGitExec })).toBeNull();
  });

  it("withholds the push from a diverged workspace instead of retrying a rejected one", async () => {
    const { workspace, remote } = initWorkspaceWithRemote("alice");
    commitLocally(workspace, "LOCAL.md", "written here\n");
    advanceRemoteFromASibling("alice", remote);
    const localHead = testGitExec(workspace, ["rev-parse", "HEAD"]);
    const remoteHead = testGitExec(remote, ["rev-parse", "main"]);
    const attempted: string[][] = [];
    const recordingGitExec = (cwd: string, argv: string[]): string | null => {
      if (argv[0] === "push") attempted.push(argv);
      return testGitExec(cwd, argv);
    };

    const report = await retryAllCustomerRepositoryPushes({
      gitExec: recordingGitExec,
      prepareRepository: prepareTestRepository,
    });

    expect(attempted).toEqual([]);
    expect(report.diverged).toEqual(["alice"]);
    expect(testGitExec(workspace, ["rev-parse", "HEAD"])).toBe(localHead);
    expect(testGitExec(remote, ["rev-parse", "main"])).toBe(remoteHead);
  });

  it("does not push a workspace that is only behind the remote", async () => {
    const { workspace, remote } = initWorkspaceWithRemote("alice");
    advanceRemoteFromASibling("alice", remote);
    const attempted: string[][] = [];
    const recordingGitExec = (cwd: string, argv: string[]): string | null => {
      if (argv[0] === "push") attempted.push(argv);
      return testGitExec(cwd, argv);
    };

    const report = await retryAllCustomerRepositoryPushes({
      gitExec: recordingGitExec,
      prepareRepository: prepareTestRepository,
    });

    expect(attempted).toEqual([]);
    expect(report.diverged).toEqual([]);
    expect(testGitExec(workspace, ["rev-parse", "HEAD"]))
      .not.toBe(testGitExec(remote, ["rev-parse", "main"]));
  });

  it("accepts a strict durable flush when the clean workspace is behind canonical origin", async () => {
    const { workspace, remote } = initWorkspaceWithRemote("alice");
    advanceRemoteFromASibling("alice", remote);
    const attempted: string[][] = [];
    const recordingGitExec = (cwd: string, argv: string[]): string | null => {
      if (argv[0] === "push") attempted.push(argv);
      return testGitExec(cwd, argv);
    };

    await expect(syncCustomerRepositoriesForSlug("alice", {
      strict: true,
      gitExec: recordingGitExec,
      prepareRepository: prepareTestRepository,
    })).resolves.toEqual({ diverged: [] });

    expect(attempted).toEqual([]);
    expect(testGitExec(workspace, ["rev-parse", "HEAD"]))
      .not.toBe(testGitExec(remote, ["rev-parse", "main"]));
  });

  it("still pushes a workspace holding commits the remote does not have", async () => {
    const { workspace, remote } = initWorkspaceWithRemote("alice");
    commitLocally(workspace, "LOCAL.md", "written here\n");

    const report = await retryAllCustomerRepositoryPushes({
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    });

    expect(report.diverged).toEqual([]);
    expect(testGitExec(remote, ["rev-parse", "main"]))
      .toBe(testGitExec(workspace, ["rev-parse", "HEAD"]));
  });

  it("merges identical-tree workspace checkpoints without discarding either history", async () => {
    const { workspace, remote } = initWorkspaceWithRemote("alice");
    advanceRemoteFromASibling("alice", remote);
    commitLocally(workspace, "SIBLING.md", "written by the other pod\n");
    execFileSync("git", ["commit", "--amend", "-q", "-m", "local checkpoint"], { cwd: workspace });
    const localHead = testGitExec(workspace, ["rev-parse", "HEAD"])!;
    const remoteHead = testGitExec(remote, ["rev-parse", "main"])!;
    const tree = testGitExec(workspace, ["rev-parse", "HEAD^{tree}"]);
    await expect(syncCustomerRepositoriesForSlug("alice", {
      strict: true,
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    })).resolves.toEqual({ diverged: [] });
    expect(testGitExec(workspace, ["rev-parse", "HEAD^{tree}"])).toBe(tree);
    expect(testGitExec(remote, ["rev-parse", "main"])).toBe(testGitExec(workspace, ["rev-parse", "HEAD"]));
    expect(testGitExec(workspace, ["merge-base", "--is-ancestor", localHead, "HEAD"])).toBe("");
    expect(testGitExec(workspace, ["merge-base", "--is-ancestor", remoteHead, "HEAD"])).toBe("");
  });

  it.each(["merge", "push"])("blocks the flush when identical-tree checkpoint %s fails", async (failure) => {
    const { workspace, remote } = initWorkspaceWithRemote("alice");
    advanceRemoteFromASibling("alice", remote);
    commitLocally(workspace, "SIBLING.md", "written by the other pod\n");
    execFileSync("git", ["commit", "--amend", "-q", "-m", "local checkpoint"], { cwd: workspace });
    const remoteHead = testGitExec(remote, ["rev-parse", "main"]);
    const runGit = (cwd: string, args: string[]): string | null =>
      args[0] === failure ? null : testGitExec(cwd, args);

    await expect(syncCustomerRepositoriesForSlug("alice", {
      strict: true,
      gitExec: runGit,
      prepareRepository: prepareTestRepository,
    })).rejects.toThrow(failure === "merge" ? /checkpoint merge failed/ : /push failed/);
    expect(testGitExec(remote, ["rev-parse", "main"])).toBe(remoteHead);
  });

  it("fails a strict flush on divergence rather than reporting a durable checkpoint", async () => {
    const { workspace, remote } = initWorkspaceWithRemote("alice");
    commitLocally(workspace, "LOCAL.md", "written here\n");
    advanceRemoteFromASibling("alice", remote);

    await expect(syncCustomerRepositoriesForSlug("alice", {
      strict: true,
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    })).rejects.toThrow(/alice.*diverged/iu);
    expect(workspace).toBeTruthy();
  });

  it("resets a diverged imported workspace onto the remote it must push to next", () => {
    const { workspace, remote } = initWorkspaceWithRemote("alice");
    commitLocally(workspace, "LOCAL.md", "stale import checkpoint\n");
    advanceRemoteFromASibling("alice", remote);

    const state = reconcileImportedWorkspace("alice", {
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    });

    expect(state).toBe("diverged");
    expect(testGitExec(workspace, ["rev-parse", "HEAD"]))
      .toBe(testGitExec(remote, ["rev-parse", "main"]));
    expect(fs.existsSync(path.join(workspace, "SIBLING.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "LOCAL.md"))).toBe(false);
  });

  it("fast-forwards an imported workspace that is merely behind", () => {
    const { workspace, remote } = initWorkspaceWithRemote("alice");
    advanceRemoteFromASibling("alice", remote);

    const state = reconcileImportedWorkspace("alice", {
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    });

    expect(state).toBe("behind");
    expect(testGitExec(workspace, ["rev-parse", "HEAD"]))
      .toBe(testGitExec(remote, ["rev-parse", "main"]));
  });

  it("aligns a dirty imported snapshot with canonical history without losing its files", async () => {
    const { workspace, remote } = initWorkspaceWithRemote("alice");
    commitLocally(workspace, "AGENTS.md", "original instructions\n");
    testGitExec(workspace, ["push", "origin", "main"]);
    const sibling = path.join(paths.root, "import-source");
    execFileSync("git", ["clone", "-q", remote, sibling]);
    execFileSync("git", ["config", "user.email", "test@octogee.test"], { cwd: sibling });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: sibling });
    commitLocally(sibling, "AGENTS.md", "source checkpoint instructions\n");
    testGitExec(sibling, ["push", "origin", "main"]);
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "imported Builder instructions\n");
    fs.writeFileSync(path.join(workspace, "TOOLS.md"), "imported tools\n");

    expect(reconcileImportedWorkspace("alice", {
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    })).toBe("behind");
    expect(testGitExec(workspace, ["rev-parse", "HEAD"]))
      .toBe(testGitExec(remote, ["rev-parse", "main"]));
    expect(fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8"))
      .toBe("imported Builder instructions\n");
    expect(fs.readFileSync(path.join(workspace, "TOOLS.md"), "utf8"))
      .toBe("imported tools\n");

    await syncCustomerRepositoriesForSlug("alice", {
      strict: true,
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    });
    expect(testGitExec(workspace, ["rev-parse", "HEAD"]))
      .toBe(testGitExec(remote, ["rev-parse", "main"]));
    expect(testGitExec(workspace, ["status", "--porcelain"])).toBe("");
  });

  it.each(["merge", "reset", "status"])("fails import reconciliation when %s fails", (command) => {
    const { workspace, remote } = initWorkspaceWithRemote("alice");
    advanceRemoteFromASibling("alice", remote);
    if (command === "reset") fs.writeFileSync(path.join(workspace, "TOOLS.md"), "imported tools\n");
    expect(() => reconcileImportedWorkspace("alice", {
      gitExec: (cwd, args) => args[0] === command ? null : testGitExec(cwd, args),
      prepareRepository: prepareTestRepository,
    })).toThrow(/import reconcile/);
  });

  it("fails import reconciliation when resetting a divergent checkpoint fails", () => {
    const { workspace, remote } = initWorkspaceWithRemote("alice");
    commitLocally(workspace, "LOCAL.md", "local checkpoint\n");
    advanceRemoteFromASibling("alice", remote);
    expect(() => reconcileImportedWorkspace("alice", {
      gitExec: (cwd, args) => args[0] === "reset" ? null : testGitExec(cwd, args),
      prepareRepository: prepareTestRepository,
    })).toThrow(/import reconcile/);
  });

  it("leaves an imported workspace holding unpushed commits alone", () => {
    const { workspace, remote } = initWorkspaceWithRemote("alice");
    commitLocally(workspace, "LOCAL.md", "not yet pushed\n");
    const localHead = testGitExec(workspace, ["rev-parse", "HEAD"]);

    const state = reconcileImportedWorkspace("alice", {
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    });

    expect(state).toBe("ahead");
    expect(testGitExec(workspace, ["rev-parse", "HEAD"])).toBe(localHead);
    expect(testGitExec(remote, ["rev-parse", "main"])).not.toBe(localHead);
  });

  it("never resets a project repository, only the workspace", () => {
    const { workspace } = initWorkspaceWithRemote("alice");
    fs.writeFileSync(path.join(workspace, ".gitignore"), "projects/\n");
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    execFileSync("git", ["commit", "-q", "-m", "ignore projects"], { cwd: workspace });
    const project = path.join(workspace, "projects", "launch");
    const projectRemote = path.join(paths.root, "remotes", "launch.git");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(projectRemote, { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: projectRemote });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
    execFileSync("git", ["config", "user.email", "test@octogee.test"], { cwd: project });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
    execFileSync("git", ["remote", "add", "origin", projectRemote], { cwd: project });
    commitLocally(project, "README.md", "real project history\n");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: project });
    advanceRemoteFromASibling("launch", projectRemote);
    commitLocally(project, "WIP.md", "diverging project work\n");
    const projectHead = testGitExec(project, ["rev-parse", "HEAD"]);

    reconcileImportedWorkspace("alice", {
      gitExec: testGitExec,
      prepareRepository: prepareTestRepository,
    });

    expect(testGitExec(project, ["rev-parse", "HEAD"])).toBe(projectHead);
    expect(fs.existsSync(path.join(project, "WIP.md"))).toBe(true);
  });
});

describe("blob sync without a manifest", () => {
  it("uploads and records local blobs when no manifest exists yet", async () => {
    const blobsDir = path.join(paths.customers, "aug29", ".blobs");
    fs.mkdirSync(blobsDir, { recursive: true });
    fs.writeFileSync(path.join(blobsDir, "avatar.png"), "png-bytes");

    const written: Array<{ contents: string; ifGenerationMatch: string }> = [];
    const upload = vi.fn(async () => {});

    await blobSyncForSlug("aug29", {
      store: {
        manifestFor: () => ({
          read: async () => null,
          write: async (_p: string, contents: string, ifGenerationMatch: string) => {
            written.push({ contents, ifGenerationMatch });
          },
        }),
        download: vi.fn(async () => {}),
        upload,
      },
    });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
    expect(written[0].ifGenerationMatch).toBe("0");
    expect(JSON.parse(written[0].contents)["avatar.png"]).toMatchObject({
      type: "blob",
      gcsPath: "customers/aug29/avatar.png",
    });
  });
});

describe("canonical customer git config", () => {
  it("configures main's upstream, without which a clean checkout never fast-forwards", () => {
    const repo = path.join(paths.customers, "upstreamcheck");
    fs.mkdirSync(repo, { recursive: true });
    const gitDir = externalizeCustomerGitDir(repo, { fetchCanonical: () => {} });
    expect(gitDir).not.toBeNull();
    const config = fs.readFileSync(path.join(gitDir!, "config"), "utf8");
    expect(config).toContain('[branch "main"]');
    expect(config).toContain("remote = origin");
    expect(config).toContain("merge = refs/heads/main");
  });

  it("ignores the blob manifest — it is server-side state, not repo content", () => {
    const ignore = workspaceGitignore();
    expect(ignore).toContain(".files/");
    expect(ignore).toContain("projects/");
  });
});
