import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  syncAllWorkspaces,
  syncCustomerRepositoriesForSlug,
} = await import("../lib/git.js");
const { blobSyncAllWithOptions, blobSyncForSlug } = await import("../lib/blob-sync.js");

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
    execFileSync("git", ["init", "-q", "--bare"], { cwd: remote });
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
      store: { download: vi.fn(async () => {}), upload },
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
        download: vi.fn(async () => {}),
        upload: vi.fn(async () => { throw new Error("storage unavailable"); }),
      }),
    })).rejects.toThrow(/alice.*storage unavailable/i);
  });
});
