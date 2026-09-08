import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { customerFileStatePaths, flushCustomerFiles } from "../lib/customer-file-state.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
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
