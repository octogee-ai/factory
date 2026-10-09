import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { customerFileStatePaths, flushCustomerFiles, removeDepartedCustomerFileState } from "../lib/customer-file-state.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
it("fails the lifecycle flush if project publication fails and preserves local data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "customer-file-state-")); roots.push(root);
  const project = path.join(root, "customers/alice/projects/demo");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "edit.txt"), "unsaved");
  const persistProjects = vi.fn(async () => { throw new Error("remote unavailable"); });
  await expect(flushCustomerFiles("alice", { root, persistProjects })).rejects.toThrow("remote unavailable");
  expect(persistProjects).toHaveBeenCalledWith("alice");
  expect(await fs.readFile(path.join(project, "edit.txt"), "utf8")).toBe("unsaved");
});
it("preserves branches, staging, untracked files and unpublished commits across two transfers without publishing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "customer-file-state-")); roots.push(root);
  const remote = path.join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
  let current = path.join(root, "source");
  const repo = path.join(current, "customers/alice/projects/demo");
  const metadata = path.join(current, "git-metadata/alice/projects/demo.git");
  await fs.mkdir(repo, { recursive: true }); await fs.mkdir(path.dirname(metadata), { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main", "--separate-git-dir", metadata, repo]);
  git(repo, "config", "user.name", "Alice"); git(repo, "config", "user.email", "alice@example.test");
  git(repo, "remote", "add", "origin", remote);
  await fs.writeFile(path.join(repo, "file.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-m", "base"); git(repo, "push", "origin", "main");
  const published = git(remote, "rev-parse", "main");
  await fs.writeFile(path.join(repo, "file.txt"), "stashed\n");
  git(repo, "stash", "push", "-m", "unfinished idea");
  const stash = git(repo, "rev-parse", "refs/stash");
  git(repo, "switch", "-c", "work"); await fs.writeFile(path.join(repo, "file.txt"), "committed\n"); git(repo, "commit", "-am", "local work");
  const local = git(repo, "rev-parse", "HEAD");
  await fs.writeFile(path.join(repo, "file.txt"), "staged\n"); git(repo, "add", "file.txt");
  await fs.writeFile(path.join(repo, "file.txt"), "unstaged\n"); await fs.writeFile(path.join(repo, "notes.txt"), "untracked\n");
  for (const destination of ["dedicated", "returned"]) {
    await flushCustomerFiles("alice", { root: current });
    const target = path.join(root, destination);
    for (const source of await customerFileStatePaths(current, "alice")) {
      await fs.mkdir(path.dirname(path.join(target, source.path)), { recursive: true });
      await fs.cp(path.join(source.cwd, source.path), path.join(target, source.path), { recursive: true });
    }
    current = target;
    const checkout = path.join(current, "customers/alice/projects/demo");
    await fs.writeFile(path.join(checkout, ".git"), `gitdir: ${path.join(current, "git-metadata/alice/projects/demo.git")}\n`);
    expect(git(checkout, "rev-parse", "refs/stash")).toBe(stash);
    expect(git(checkout, "branch", "--show-current")).toBe("work"); expect(git(checkout, "rev-parse", "HEAD")).toBe(local);
    expect(git(checkout, "show", ":file.txt")).toBe("staged");
    expect(await fs.readFile(path.join(checkout, "file.txt"), "utf8")).toBe("unstaged\n");
    expect(await fs.readFile(path.join(checkout, "notes.txt"), "utf8")).toBe("untracked\n");
    expect(git(remote, "rev-parse", "main")).toBe(published);
  }
});
it("rejects a flush for a missing customer instead of claiming durability", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "customer-file-state-")); roots.push(root);
  await expect(flushCustomerFiles("missing", { root })).rejects.toThrow();
});
it("refuses to remove departed state for a slug that is not a customer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "customer-file-state-")); roots.push(root);
  await fs.mkdir(path.join(root, "git-metadata", "alice"), { recursive: true });
  await expect(removeDepartedCustomerFileState("..", { root, log: vi.fn() })).rejects.toThrow("Invalid customer slug");
  await expect(fs.stat(path.join(root, "git-metadata", "alice"))).resolves.toBeDefined();
});
it("keeps the customer workspace until the rest of its departed state is gone", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "customer-file-state-")); roots.push(root);
  await fs.mkdir(path.join(root, "customers", "alice"), { recursive: true });
  await fs.mkdir(path.join(root, "git-metadata", "alice", "workspace.git"), { recursive: true });
  await fs.mkdir(path.join(root, "secrets"), { recursive: true });
  await fs.writeFile(path.join(root, "secrets", "agent-model-token-expiry"), "");
  await expect(removeDepartedCustomerFileState("alice", { root, log: vi.fn() })).rejects.toThrow(/ENOTDIR/);
  await expect(fs.stat(path.join(root, "customers", "alice"))).resolves.toBeDefined();
});
it("removes a customer named quarantine without touching other customers' quarantined Git metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "customer-file-state-")); roots.push(root);
  const othersQuarantine = path.join(root, "git-metadata-quarantine", "alice", "workspace.git-stale");
  await fs.mkdir(othersQuarantine, { recursive: true });
  await fs.mkdir(path.join(root, "customers", "quarantine"), { recursive: true });
  await fs.mkdir(path.join(root, "git-metadata", "quarantine", "workspace.git"), { recursive: true });
  expect(await customerFileStatePaths(root, "quarantine")).toEqual([
    { cwd: root, path: "customers/quarantine" },
    { cwd: root, path: "git-metadata/quarantine" },
  ]);
  await removeDepartedCustomerFileState("quarantine", { root, log: vi.fn() });
  await expect(fs.stat(othersQuarantine)).resolves.toBeDefined();
  await expect(fs.stat(path.join(root, "git-metadata", "quarantine"))).rejects.toThrow(/ENOENT/);
});
