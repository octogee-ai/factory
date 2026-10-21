import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireWorkspaceMutationLeaseSync } from "@octogee/core/workspace-mutation-lease";
import { ADD_CUSTOMER_DEADLINE_MS } from "../../shared/types/fleet-controller.js";
import type { CustomerLifecycleAdapter, ProjectCloneOptions } from "../lib/customer-lifecycle.js";

const paths = vi.hoisted(() => ({ root: `/tmp/octogee-builder-project-preparation-${process.pid}` }));
vi.mock("../lib/config.js", () => ({
  log: vi.fn(), dlog: vi.fn(), OPENCLAW_DIR: paths.root,
  CUSTOMERS_DIR: `${paths.root}/customers`, CUSTOMER_KEYS_DIR: `${paths.root}/keys`,
  AGENTS_DIR: `${paths.root}/agents`, GIT_API_URL: "http://gitea.test", GIT_SSH_HOST: "gitea",
}));
vi.mock("../lib/gitea-admin-broker-client.js", () => ({ repoExists: vi.fn(async () => true) }));
vi.mock("../lib/migration-activation-manifest.js", () => ({ readActivationManifest: vi.fn(async () => ({ slug: "alice" })) }));
const { cloneProjectRepo, customerRepositoryHasCanonicalRemote, projectCheckoutMatchesSource } = await import("../lib/git.js");
const { createBuilderSurgeGateWiring } = await import("../lib/fleet-provisioner.js");
const slug = "alice", project = "demo", dir = `${paths.root}/customers/${slug}/projects/${project}`;
let origin: string, seed: string;
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
beforeEach(() => {
  fs.rmSync(paths.root, { recursive: true, force: true });
  seed = path.join(paths.root, "seed"); origin = path.join(paths.root, "origin.git");
  fs.mkdirSync(seed, { recursive: true }); fs.mkdirSync(origin);
  git(origin, ["init", "--bare", "-b", "main"]); git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "Test"]); git(seed, ["config", "user.email", "test@octogee.test"]);
  fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
  fs.writeFileSync(path.join(seed, "IDENTITY.md"), "old identity\n"); git(seed, ["add", "."]); git(seed, ["commit", "-m", "seed"]);
  git(seed, ["remote", "add", "origin", origin]); git(seed, ["push", "origin", "main"]);
  const metadata = `${paths.root}/git-metadata/${slug}/projects/${project}.git`;
  fs.mkdirSync(path.dirname(metadata), { recursive: true }); fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(paths.root, ["clone", "--separate-git-dir", metadata, origin, dir]);
  git(dir, ["remote", "set-url", "origin", `git@gitea:${slug}/${project}.git`]);
  fs.writeFileSync(`${metadata}.octogee-trusted-v3`, `octogee-customer-git-v3\ngitea:${project}\n`);
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${metadata}\n`);
  fs.mkdirSync(`${paths.root}/keys/${slug}`, { recursive: true });
  fs.writeFileSync(`${paths.root}/keys/${slug}/id_ed25519`, "isolated test key; no SSH execution");
});
afterEach(() => { fs.rmSync(paths.root, { recursive: true, force: true }); });

function wiring(failGitCommand?: string) {
  const gitCalls: string[][] = [];
  const snapshot = { uid: "uid-alice", slug, gatewayId: "alice-builder", status: "complete",
    projectCheckoutScope: "workspace-and-projects", projects: [{ projectSlug: project, giteaRepoName: project, provisioningState: "active" }] };
  const adapter = {
    log: vi.fn(), uidForSlug: async () => snapshot.uid, loadUserSnapshot: vi.fn(async () => snapshot),
    listProjectsNeedingClone: vi.fn(async () => customerRepositoryHasCanonicalRemote(dir) && projectCheckoutMatchesSource(slug, project, project) ? [] : snapshot.projects),
    cloneProjectRepo: async (_slug: string, _project: string, repo: string, opts?: ProjectCloneOptions) => cloneProjectRepo(slug, project, repo, {
      ...opts, gitExec: (cwd, args) => {
        gitCalls.push(args);
        if (args[0] === failGitCommand) return null;
        try { return git(cwd, args[0] === "fetch" ? ["fetch", "--no-tags", origin, "+refs/heads/*:refs/remotes/origin/*"] : args); }
        catch { return null; }
      },
    }),
  } as unknown as CustomerLifecycleAdapter;
  const request = { migrationId: "activation-test", slug, targetPodUid: "target-pod" };
  const processGate = { status: async () => ({ version: 1, podUid: request.targetPodUid, role: "target", mode: "held", phase: "held", ...request }) };
  return { adapter, request, gitCalls, gate: createBuilderSurgeGateWiring({ adapter, processGate: processGate as never,
    waitForGatewayHealthy: async () => undefined,
    surgeReadiness: {} as never, waitForGatewayReady: async () => undefined, log: vi.fn(), openclawDir: paths.root,
    provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
    attachConfiguredBuilderBeforeOpenClaw: async () => slug,
  }) };
}

function holdProjectLease() {
  const gitDir = path.join(paths.root, "git-source-switch-locks", slug, `${project}.git`);
  fs.mkdirSync(gitDir, { recursive: true });
  const lease = acquireWorkspaceMutationLeaseSync({ workspaceDir: dir, gitDir });
  if (!lease) throw new Error("isolated project lease fixture is unexpectedly busy");
  return lease;
}

describe("configured Builder preparation of retained canonical projects", () => {
  it("waits for an active project writer before attempting the refresh once", async () => {
    const lease = holdProjectLease();
    const { gate, request, gitCalls } = wiring();
    let released = false;
    let gitRanWhileHeld = false;
    const timer = setTimeout(() => {
      gitRanWhileHeld = gitCalls.length > 0;
      lease.release();
      released = true;
    }, 40);
    try {
      await expect(gate.prepareSurgeTarget(request)).resolves.toBeUndefined();
      expect(released).toBe(true);
      expect(gitRanWhileHeld).toBe(false);
      expect(gitCalls.filter(args => args[0] === "fetch")).toHaveLength(1);
      const next = holdProjectLease();
      next.release();
    } finally {
      clearTimeout(timer);
      if (!released) lease.release();
    }
  });

  it("stops waiting at the customer preparation deadline while preserving an active writer's lease", async () => {
    const lease = holdProjectLease();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { gate, request, gitCalls } = wiring();
    let settled = false;
    let failure: unknown;
    const preparation = gate.prepareSurgeTarget(request)
      .catch(error => { failure = error; })
      .finally(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(ADD_CUSTOMER_DEADLINE_MS - 1);
      expect(settled).toBe(false);
      expect(gitCalls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await preparation;
      expect(failure).toMatchObject({ message: expect.stringContaining("pending repositories: demo") });
      expect(settled).toBe(true);
      expect(gitCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      lease.release();
    }
  });

  it("does not acquire a released lease when the final wait wakes after the preparation deadline", async () => {
    const lease = holdProjectLease();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const now = vi.spyOn(performance, "now");
    const { gate, request, gitCalls } = wiring();
    let released = false;
    let settled = false;
    let failure: unknown;
    const preparation = gate.prepareSurgeTarget(request)
      .catch(error => { failure = error; })
      .finally(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(ADD_CUSTOMER_DEADLINE_MS - 100);
      expect(settled).toBe(false);
      expect(gitCalls).toHaveLength(0);
      now.mockReturnValue(ADD_CUSTOMER_DEADLINE_MS + 1);
      lease.release();
      released = true;
      await vi.advanceTimersByTimeAsync(100);
      await preparation;
      expect(failure).toMatchObject({ message: expect.stringContaining("pending repositories: demo") });
      expect(gitCalls).toHaveLength(0);
    } finally {
      if (!released) lease.release();
      await vi.runAllTimersAsync();
      await preparation;
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it("cancels a busy refresh when the owning finish-import request aborts", async () => {
    const lease = holdProjectLease();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const controller = new AbortController();
    const { gate, request, gitCalls } = wiring();
    let settled = false;
    let failure: unknown;
    const preparation = gate.prepareSurgeTarget(request, controller.signal)
      .catch(error => { failure = error; })
      .finally(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new Error("finish import cancelled"));
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(true);
      expect(failure).toMatchObject({ message: "finish import cancelled" });
      expect(gitCalls).toHaveLength(0);
    } finally {
      await vi.runAllTimersAsync();
      await preparation;
      vi.useRealTimers();
      lease.release();
    }
  });

  it("does not retry a Git failure after acquiring the project lease", async () => {
    const { gate, request, gitCalls } = wiring("fetch");
    await expect(gate.prepareSurgeTarget(request)).rejects.toThrow("pending repositories: demo");
    expect(gitCalls.filter(args => args[0] === "fetch")).toHaveLength(1);
    const next = holdProjectLease();
    next.release();
  });

  it.each(["unstaged", "staged", "conflicting"])("preserves transferred work while absorbing an identity already committed upstream (%s)", async state => {
    const originalHead = git(dir, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(seed, "IDENTITY.md"), "saved identity\n");
    fs.writeFileSync(path.join(seed, "lifecycle-proof.txt"), "committed project continuity\n");
    if (state === "conflicting") fs.writeFileSync(path.join(seed, "README.md"), "new remote text\n");
    git(seed, ["add", "."]); git(seed, ["commit", "-m", "saved identity"]); git(seed, ["push", "origin", "main"]);
    if (state === "staged") {
      fs.writeFileSync(path.join(dir, "IDENTITY.md"), "keep staged identity\n");
      git(dir, ["add", "IDENTITY.md"]);
    }
    const originalIndex = git(dir, ["rev-parse", ":IDENTITY.md"]);
    fs.writeFileSync(path.join(dir, "IDENTITY.md"), "saved identity\n");
    fs.writeFileSync(path.join(dir, "README.md"), "keep local edit\n");
    fs.writeFileSync(path.join(dir, "local-only.md"), "keep untracked work\n");
    const { gate, request } = wiring();

    if (state === "unstaged") {
      await expect(gate.prepareSurgeTarget(request)).resolves.toBeUndefined();
      expect(git(dir, ["rev-parse", "HEAD"])).toBe(git(seed, ["rev-parse", "HEAD"]));
      expect(git(dir, ["rev-parse", ":IDENTITY.md"])).toBe(git(seed, ["rev-parse", "HEAD:IDENTITY.md"]));
      expect(git(dir, ["diff", "--cached", "--name-only"])).toBe("");
      expect(fs.readFileSync(path.join(dir, "lifecycle-proof.txt"), "utf8")).toBe("committed project continuity\n");
    } else {
      await expect(gate.prepareSurgeTarget(request)).rejects.toThrow("pending repositories: demo");
      expect(git(dir, ["rev-parse", "HEAD"])).toBe(originalHead);
      expect(git(dir, ["rev-parse", ":IDENTITY.md"])).toBe(originalIndex);
    }
    expect(fs.readFileSync(path.join(dir, "IDENTITY.md"), "utf8")).toBe("saved identity\n");
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("keep local edit\n");
    expect(fs.readFileSync(path.join(dir, "local-only.md"), "utf8")).toBe("keep untracked work\n");
  });

  it.each([false, true])("refreshes the cached project before preparation completes (conflicting local work=%s)", async conflict => {
    const originalHead = git(dir, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(seed, "lifecycle-proof.txt"), "committed project continuity\n");
    if (conflict) fs.writeFileSync(path.join(seed, "README.md"), "new remote text\n");
    git(seed, ["add", "."]); git(seed, ["commit", "-m", "saved project work"]); git(seed, ["push", "origin", "main"]);
    git(dir, ["fetch", origin, "+refs/heads/*:refs/remotes/origin/*"]);
    fs.writeFileSync(path.join(dir, "README.md"), "keep local edit\n");
    fs.writeFileSync(path.join(dir, "local-only.md"), "keep untracked work\n");
    expect(customerRepositoryHasCanonicalRemote(dir)).toBe(true);
    expect(git(dir, ["rev-parse", "HEAD"])).not.toBe(git(dir, ["rev-parse", "origin/main"]));
    const { gate, request, adapter } = wiring();
    if (conflict) {
      await expect(gate.prepareSurgeTarget(request)).rejects.toThrow("pending repositories: demo");
      expect(git(dir, ["rev-parse", "HEAD"])).toBe(originalHead);
    } else {
      await gate.prepareSurgeTarget(request);
      expect(fs.existsSync(path.join(dir, "lifecycle-proof.txt"))).toBe(true);
      expect(fs.readFileSync(path.join(dir, "lifecycle-proof.txt"), "utf8")).toBe("committed project continuity\n");
      expect(git(dir, ["rev-parse", "HEAD"])).toBe(git(seed, ["rev-parse", "HEAD"]));
      expect(adapter.loadUserSnapshot).toHaveBeenCalledWith("uid-alice", { refresh: true });
    }
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("keep local edit\n");
    expect(fs.readFileSync(path.join(dir, "local-only.md"), "utf8")).toBe("keep untracked work\n");
  });
});
