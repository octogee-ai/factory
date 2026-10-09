import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({
  customers: `${process.platform === "linux" ? "/dev/shm" : "/tmp"}/octogee-gh-project-${process.pid}`,
  keys: `/tmp/octogee-gh-project-keys-${process.pid}`,
  scratch: `/tmp/octogee-gh-project-scratch-${process.pid}`,
  openclaw: `/tmp/octogee-gh-project-openclaw-${process.pid}`,
}));

vi.mock("../lib/config.js", () => ({
  log: vi.fn((message: string) => {
    if (process.env.DEBUG_GIT_LOG) process.stderr.write(`${message}\n`);
  }),
  dlog: vi.fn(),
  GIT_API_URL: "http://gitea-http.octogee.svc.cluster.local:3000/api/v1",
  GIT_SSH_HOST: "gitea",
  OPENCLAW_DIR: paths.openclaw,
  CUSTOMERS_DIR: paths.customers,
  CUSTOMER_KEYS_DIR: paths.keys,
  AGENTS_DIR: "/tmp/octogee-test/agents",
}));

const broker = vi.hoisted(() => ({
  clone: null as null | ((slug: string, projectSlug: string) => Promise<boolean>),
  calls: 0,
}));

vi.mock("../lib/github-project-clone-broker.js", () => ({
  cloneGithubProjectViaBroker: vi.fn(async (slug: string, projectSlug: string) => {
    broker.calls += 1;
    if (!broker.clone) throw new Error("broker not configured for this test");
    return broker.clone(slug, projectSlug);
  }),
}));

vi.mock("../lib/gitea-admin-broker-client.js", () => ({
  repoExists: vi.fn(async () => true),
  ensureGiteaUser: vi.fn(async () => {}),
  readGiteaUserPubKeys: vi.fn(async () => []),
  ensureWorkspaceRepo: vi.fn(async () => {}),
  ensureProjectRepo: vi.fn(async () => {}),
  archiveRepo: vi.fn(async () => {}),
}));

const {
  cloneProjectRepo,
  externalizeCustomerGitDir,
  githubCloneCredentialEnv,
  projectCheckoutMatchesSource,
} = await import("../lib/git.js");

const SLUG = "alice";
const GITHUB_REMOTE = "https://github.com/octogee-ai/demo.git";
const GITHUB_REMOTE_B = "https://github.com/octogee-ai/demo2.git";
const GITEA_SSH_REMOTE = `git@gitea:${SLUG}/demo.git`;
const MATERIALIZED_TOKEN = "ghs_materialized_token_must_not_touch_disk";

const savedEnv: Record<string, string | undefined> = {};
let canonicalOrigin: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function localGitExec(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function localConfig(repo: string, key: string): string {
  const localGit = path.join(repo, ".git");
  const stat = fs.lstatSync(localGit);
  const config = stat.isDirectory()
    ? path.join(localGit, "config")
    : path.join(fs.readFileSync(localGit, "utf8").trim().slice("gitdir: ".length), "config");
  return git(repo, ["config", "--file", config, "--get", key]);
}

function localConfigContents(repo: string): string {
  const localGit = path.join(repo, ".git");
  const stat = fs.lstatSync(localGit);
  const config = stat.isDirectory()
    ? path.join(localGit, "config")
    : path.join(fs.readFileSync(localGit, "utf8").trim().slice("gitdir: ".length), "config");
  return fs.readFileSync(config, "utf8");
}

const prepareRepository = () => {};

function prepareTrustedGithubRepository(
  repoDir: string,
  _slug: string,
  deps: { repoSource?: { provider: string; owner: string; repo: string } | null },
): void {
  const source = deps.repoSource;
  if (source?.provider !== "github") throw new Error("expected GitHub source");
  const projectSlug = path.basename(repoDir);
  const metadata = path.join(
    paths.openclaw,
    "git-metadata",
    SLUG,
    "projects",
    `${projectSlug}.git`,
  );
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.cpSync(path.join(repoDir, ".git"), metadata, { recursive: true });
  fs.rmSync(path.join(repoDir, ".git"), { recursive: true });
  fs.writeFileSync(`${metadata}.octogee-trusted-v3`, [
    "octogee-customer-git-v3",
    `github:${source.owner}/${source.repo}`,
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(repoDir, ".git"), `gitdir: ${metadata}\n`);
}

function seedBareOrigin(): string {
  const origin = path.join(paths.scratch, "origin.git");
  const seed = path.join(paths.scratch, "seed");
  fs.mkdirSync(origin, { recursive: true });
  fs.mkdirSync(seed, { recursive: true });
  git(origin, ["init", "-q", "--bare", "-b", "main"]);
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "user.email", "seed@octogee.test"]);
  git(seed, ["config", "user.name", "Seed"]);
  fs.writeFileSync(path.join(seed, "README.md"), "from github\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "seed"]);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "origin", "main"]);
  return origin;
}

function rebuildTransferredGithubMetadata(
  repoDir: string,
  _slug: string,
  deps: { repoSource?: { provider: "github"; owner: string; repo: string } | null },
): void {
  externalizeCustomerGitDir(repoDir, {
    repoSource: deps.repoSource,
    fetchCanonical: (worktree, gitDir) => {
      execFileSync("git", [
        "--git-dir",
        gitDir,
        "--work-tree",
        worktree,
        "fetch",
        canonicalOrigin,
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
    },
  });
}

function initRepoWithOrigin(repo: string, remoteUrl: string): void {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@octogee.test"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "checked in\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  git(repo, ["remote", "add", "origin", remoteUrl]);
}

beforeEach(() => {
  for (const dir of [paths.customers, paths.keys, paths.scratch, paths.openclaw]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  if (process.platform === "linux") {
    expect(fs.statSync(paths.customers).dev).not.toBe(fs.statSync(paths.openclaw).dev);
  }
  const origin = seedBareOrigin();
  canonicalOrigin = origin;
  const globalConfig = path.join(paths.scratch, "gitconfig");
  fs.writeFileSync(
    globalConfig,
    [
      "[http]",
      "\tproxy = http://127.0.0.1:1",
      `[url "${origin}"]`,
      `\tinsteadOf = ${GITHUB_REMOTE}`,
      `\tinsteadOf = ${GITHUB_REMOTE_B}`,
      `\tinsteadOf = ${GITEA_SSH_REMOTE}`,
      "",
    ].join("\n"),
  );
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_SSH_COMMAND", "GATEWAY_CLASS"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_SSH_COMMAND = "false";
  process.env.GATEWAY_CLASS = "builder";
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [paths.customers, paths.keys, paths.scratch, paths.openclaw]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("cloneProjectRepo for a GitHub-backed project", () => {
  it("rebuilds a transferred checkout's missing metadata without replacing local files", async () => {
    const dest = path.join(paths.customers, SLUG, "projects", "demo");
    const metadata = path.join(paths.openclaw, "git-metadata", SLUG, "projects", "demo.git");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, ".git"), `gitdir: ${metadata}\n`);
    fs.writeFileSync(path.join(dest, "README.md"), "from github\n");
    fs.writeFileSync(path.join(dest, "local-only.md"), "preserve me\n");

    const ok = await cloneProjectRepo(SLUG, "demo", "", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: () => { throw new Error("replacement clone must not run"); },
      prepareRepository: rebuildTransferredGithubMetadata,
    });

    expect(ok).toBe(true);
    expect(fs.readFileSync(path.join(dest, "local-only.md"), "utf8")).toBe("preserve me\n");
    expect(git(dest, ["status", "--porcelain"])).toBe("?? local-only.md");
    expect(localConfig(dest, "remote.origin.url")).toBe(GITHUB_REMOTE);
    expect(fs.existsSync(metadata)).toBe(true);
    expect(fs.existsSync(path.join(paths.openclaw, "git-worktree-quarantine", SLUG))).toBe(false);
  });

  it("fails closed when rebuilt transferred metadata does not verify", async () => {
    const dest = path.join(paths.customers, SLUG, "projects", "demo");
    const metadata = path.join(paths.openclaw, "git-metadata", SLUG, "projects", "demo.git");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, ".git"), `gitdir: ${metadata}\n`);
    fs.writeFileSync(path.join(dest, "local-only.md"), "preserve me\n");
    const prepareRepository = vi.fn();

    const ok = await cloneProjectRepo(SLUG, "demo", "", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: () => { throw new Error("replacement clone must not run"); },
      prepareRepository,
    });

    expect(ok).toBe(false);
    expect(prepareRepository).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(dest, "local-only.md"), "utf8")).toBe("preserve me\n");
    expect(fs.readFileSync(path.join(dest, ".git"), "utf8")).toBe(`gitdir: ${metadata}\n`);
  });

  it("checks the GitHub repo out at the shared project path with the workspace commit identity", async () => {
    const dest = path.join(paths.customers, SLUG, "projects", "demo");

    const ok = await cloneProjectRepo(SLUG, "demo", "", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: localGitExec,
      prepareRepository,
    });

    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(dest, ".git"))).toBe(true);
    expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("from github\n");
    expect(localConfig(dest, "user.email")).toBe(`${SLUG}@octogee.com`);
    expect(localConfig(dest, "user.name")).toBe(`Octo (${SLUG})`);
  });

  it("keeps the materialized token out of the checkout's on-disk git config and remote URL", async () => {
    const dest = path.join(paths.customers, SLUG, "projects", "demo");

    await cloneProjectRepo(SLUG, "demo", "", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: localGitExec,
      prepareRepository,
    });

    expect(localConfig(dest, "remote.origin.url")).toBe(GITHUB_REMOTE);
    expect(localConfigContents(dest)).not.toContain(
      MATERIALIZED_TOKEN,
    );
  });

  it("installs an exact GitHub checkout and quarantines a pre-existing local directory", async () => {
    const dest = path.join(paths.customers, SLUG, "projects", "demo");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "local-only.md"), "local work\n");

    const ok = await cloneProjectRepo(SLUG, "demo", "", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: localGitExec,
      prepareRepository,
    });

    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(dest, "local-only.md"))).toBe(false);
    expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("from github\n");
    const quarantineRoot = path.join(paths.openclaw, "git-worktree-quarantine", SLUG);
    const quarantined = fs.readdirSync(quarantineRoot);
    expect(quarantined).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(quarantineRoot, quarantined[0]!, "local-only.md"), "utf8"),
    ).toBe("local work\n");
  });

  it("switches one trusted GitHub source to another and quarantines old-only files", async () => {
    const dest = path.join(paths.customers, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITHUB_REMOTE);
    prepareTrustedGithubRepository(dest, SLUG, {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
    });
    fs.writeFileSync(path.join(dest, "source-a-only.md"), "old source\n");

    expect(await cloneProjectRepo(SLUG, "demo", "demo", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo2" },
      gitExec: localGitExec,
      prepareRepository: prepareTrustedGithubRepository,
    })).toBe(true);

    expect(localConfig(dest, "remote.origin.url")).toBe(GITHUB_REMOTE_B);
    expect(fs.existsSync(path.join(dest, "source-a-only.md"))).toBe(false);
    const quarantineRoot = path.join(paths.openclaw, "git-worktree-quarantine", SLUG);
    expect(
      fs.readdirSync(quarantineRoot).some((entry) =>
        fs.existsSync(path.join(quarantineRoot, entry, "source-a-only.md"))),
    ).toBe(true);
  });

  it("switches a legacy local-git checkout instead of assuming external metadata exists", async () => {
    const dest = path.join(paths.customers, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITEA_SSH_REMOTE);
    fs.writeFileSync(path.join(dest, "legacy-only.md"), "legacy\n");

    expect(await cloneProjectRepo(SLUG, "demo", "demo", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: localGitExec,
      prepareRepository: prepareTrustedGithubRepository,
    })).toBe(true);

    expect(localConfig(dest, "remote.origin.url")).toBe(GITHUB_REMOTE);
    expect(fs.existsSync(path.join(dest, "legacy-only.md"))).toBe(false);
  });

  it("leaves the prior checkout intact when the source-swap lease is unavailable", async () => {
    const dest = path.join(paths.customers, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITEA_SSH_REMOTE);
    fs.writeFileSync(path.join(dest, "keep.md"), "keep\n");

    expect(await cloneProjectRepo(SLUG, "demo", "demo", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: localGitExec,
      acquireMutationLease: () => null,
    })).toBe(false);

    expect(fs.readFileSync(path.join(dest, "keep.md"), "utf8")).toBe("keep\n");
    expect(localConfig(dest, "remote.origin.url")).toBe(GITEA_SSH_REMOTE);
  });

  it("keeps an interrupted source clone outside the live project inventory", async () => {
    const dest = path.join(paths.customers, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITEA_SSH_REMOTE);
    let temporary = "";
    const interruptedClone = (cwd: string, args: string[]): string | null => {
      expect(args[0]).toBe("clone");
      temporary = args[2];
      expect(path.dirname(temporary)).toBe(path.join(path.dirname(dest), ".octogee-state"));
      expect(fs.readdirSync(path.dirname(dest)).sort()).toEqual([".octogee-state", "demo"]);
      return null;
    };

    expect(await cloneProjectRepo(SLUG, "demo", "demo", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: interruptedClone,
    })).toBe(false);

    expect(fs.existsSync(temporary)).toBe(false);
    expect(localConfig(dest, "remote.origin.url")).toBe(GITEA_SSH_REMOTE);
  });

  it("rejects a redirected project state directory before cloning", async () => {
    const dest = path.join(paths.customers, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITEA_SSH_REMOTE);
    fs.symlinkSync(paths.scratch, path.join(path.dirname(dest), ".octogee-state"));
    const before = fs.readdirSync(paths.scratch);
    const runGit = vi.fn(() => null);

    await expect(cloneProjectRepo(SLUG, "demo", "demo", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: runGit,
    })).rejects.toThrow("project state is not a directory");

    expect(runGit).not.toHaveBeenCalled();
    expect(fs.readdirSync(paths.scratch)).toEqual(before);
    expect(localConfig(dest, "remote.origin.url")).toBe(GITEA_SSH_REMOTE);
  });

  it("restores the prior checkout when replacement preparation fails", async () => {
    const dest = path.join(paths.customers, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITEA_SSH_REMOTE);
    fs.writeFileSync(path.join(dest, "keep.md"), "keep\n");
    const failPreparation = vi.fn(() => { throw new Error("prepare failed"); });

    expect(await cloneProjectRepo(SLUG, "demo", "demo", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: localGitExec,
      prepareRepository: failPreparation,
    })).toBe(false);

    expect(failPreparation).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(dest, "keep.md"), "utf8")).toBe("keep\n");
    expect(localConfig(dest, "remote.origin.url")).toBe(GITEA_SSH_REMOTE);
  });

  it("restores prior trusted metadata when replacement preparation fails after writing new metadata", async () => {
    const dest = path.join(paths.customers, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITHUB_REMOTE);
    prepareTrustedGithubRepository(dest, SLUG, {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
    });
    fs.writeFileSync(path.join(dest, "keep.md"), "keep\n");

    expect(await cloneProjectRepo(SLUG, "demo", "demo", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo2" },
      gitExec: localGitExec,
      prepareRepository: (repoDir, slug, deps) => {
        prepareTrustedGithubRepository(repoDir, slug, deps);
        throw new Error("prepare failed after metadata write");
      },
    })).toBe(false);

    expect(fs.readFileSync(path.join(dest, "keep.md"), "utf8")).toBe("keep\n");
    expect(localConfig(dest, "remote.origin.url")).toBe(GITHUB_REMOTE);
  });

  it("hands the materialized token to git as the password, overriding any ambient helper", () => {
    const env = githubCloneCredentialEnv(MATERIALIZED_TOKEN);

    const filled = execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

    expect(filled).toContain("username=x-access-token");
    expect(filled).toContain(`password=${MATERIALIZED_TOKEN}`);
  });

  it("asks git for no credential override when no token was materialized", () => {
    expect(githubCloneCredentialEnv(null)).toBeUndefined();
    expect(githubCloneCredentialEnv("")).toBeUndefined();
  });

  it("still clones from Gitea when the project carries no GitHub repoSource", async () => {
    const keyDir = path.join(paths.keys, SLUG);
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(path.join(keyDir, "id_ed25519"), "not-a-real-key\n");
    const dest = path.join(paths.customers, SLUG, "projects", "demo");

    const ok = await cloneProjectRepo(SLUG, "demo", "demo", {
      gitExec: localGitExec,
      prepareRepository,
    });

    expect(ok).toBe(true);
    expect(localConfig(dest, "remote.origin.url")).toBe(GITEA_SSH_REMOTE);
    expect(localConfig(dest, "user.email")).toBe(`${SLUG}@octogee.com`);
  });
});

describe("GitHub checkouts brokered through gateway-edge", () => {
  const repoSource = { provider: "github" as const, owner: "octogee-ai", repo: "demo" };

  function edgeBrokerClone(): (slug: string, projectSlug: string) => Promise<boolean> {
    return async (slug, projectSlug) => {
      const dest = path.join(paths.customers, slug, "projects", projectSlug);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      git(path.dirname(dest), ["clone", "-q", canonicalOrigin, dest]);
      git(dest, ["remote", "set-url", "origin", GITHUB_REMOTE]);
      return true;
    };
  }

  beforeEach(() => {
    broker.calls = 0;
    broker.clone = edgeBrokerClone();
    process.env.GATEWAY_EDGE_INTERNAL_URL = "http://127.0.0.1:3001";
  });

  afterEach(() => {
    delete process.env.GATEWAY_EDGE_INTERNAL_URL;
    broker.clone = null;
  });

  it("prepares a brokered clone canonically so the next probe recognises the checkout", async () => {
    const dest = path.join(paths.customers, SLUG, "projects", "demo");

    const ok = await cloneProjectRepo(SLUG, "demo", "", { repoSource });

    expect(ok).toBe(true);
    expect(broker.calls).toBe(1);
    expect(fs.lstatSync(path.join(dest, ".git")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("from github\n");
    expect(projectCheckoutMatchesSource(SLUG, "demo", "", repoSource)).toBe(true);
    expect(localConfig(dest, "remote.origin.url")).toBe(GITHUB_REMOTE);
    expect(fs.readdirSync(path.dirname(dest)).filter((name) => name.startsWith(".demo-brokered-git-"))).toEqual([]);

    await expect(cloneProjectRepo(SLUG, "demo", "", { repoSource })).resolves.toBe(true);
    expect(broker.calls).toBe(1);
  });

  it("sets a checkout that does not match its GitHub source aside and re-clones through the broker", async () => {
    const dest = path.join(paths.customers, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITEA_SSH_REMOTE);
    fs.writeFileSync(path.join(dest, "local-only.md"), "local work\n");
    externalizeCustomerGitDir(dest, {
      giteaRepoName: `${SLUG}-demo`,
      fetchCanonical: (worktree, gitDir) => {
        execFileSync("git", ["--git-dir", gitDir, "--work-tree", worktree, "fetch", canonicalOrigin, "+refs/heads/*:refs/remotes/origin/*"]);
      },
    });
    expect(projectCheckoutMatchesSource(SLUG, "demo", `${SLUG}-demo`, null)).toBe(true);

    const ok = await cloneProjectRepo(SLUG, "demo", "", { repoSource });

    expect(ok).toBe(true);
    expect(broker.calls).toBe(1);
    expect(projectCheckoutMatchesSource(SLUG, "demo", "", repoSource)).toBe(true);
    expect(fs.existsSync(path.join(dest, "local-only.md"))).toBe(false);
    const quarantineRoot = path.join(paths.openclaw, "git-worktree-quarantine", SLUG);
    const quarantined = fs.readdirSync(quarantineRoot);
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(quarantineRoot, quarantined[0]!, "local-only.md"), "utf8")).toBe("local work\n");
  });

  it("reports a brokered clone whose origin is not the project's repository", async () => {
    broker.clone = async (slug, projectSlug) => {
      const dest = path.join(paths.customers, slug, "projects", projectSlug);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      git(path.dirname(dest), ["clone", "-q", canonicalOrigin, dest]);
      git(dest, ["remote", "set-url", "origin", GITHUB_REMOTE_B]);
      return true;
    };

    await expect(cloneProjectRepo(SLUG, "demo", "", { repoSource })).resolves.toBe(false);
  });
});
