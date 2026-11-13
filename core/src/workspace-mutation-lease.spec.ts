import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireWorkspaceMutationLeaseSync,
  projectMutationLeaseGitDir,
  workspaceMutationLockPath,
} from "./workspace-mutation-lease.js";

const roots: string[] = [];

function workspace(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workspace mutation lease", () => {
  it("serializes restoration and commits independently of a project's external Git pointer", () => {
    const root = workspace("external-project");
    const users = path.join(root, "customers");
    const project = path.join(users, "alice/projects/demo");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, ".git"), "gitdir: /untrusted/destination\n");
    const gitDir = projectMutationLeaseGitDir(project, users)!;
    expect(gitDir).toBe(path.join(root, "git-source-switch-locks/alice/demo.git"));
    const lease = acquireWorkspaceMutationLeaseSync({ workspaceDir: project, gitDir });
    expect(lease).not.toBeNull();
    expect(acquireWorkspaceMutationLeaseSync({ workspaceDir: project, gitDir })).toBeNull();
    lease!.release();
    expect(projectMutationLeaseGitDir(path.join(users, "../other/projects/demo"), users)).toBeNull();
  });
  it("serializes writers across processes through a lock inside git metadata", () => {
    const root = workspace("workspace-mutation");
    const first = acquireWorkspaceMutationLeaseSync({ workspaceDir: root });

    expect(first).not.toBeNull();
    expect(workspaceMutationLockPath(root)).toBe(path.join(root, ".git", "octogee.workspace-mutation.lock"));
    expect(acquireWorkspaceMutationLeaseSync({ workspaceDir: root })).toBeNull();

    first?.release();
    const next = acquireWorkspaceMutationLeaseSync({ workspaceDir: root });
    expect(next).not.toBeNull();
    next?.release();
  });

  it("does not couple independent user workspaces", () => {
    const firstRoot = workspace("workspace-one");
    const secondRoot = workspace("workspace-two");
    const first = acquireWorkspaceMutationLeaseSync({ workspaceDir: firstRoot });
    const second = acquireWorkspaceMutationLeaseSync({ workspaceDir: secondRoot });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    first?.release();
    second?.release();
  });

  it("locks explicit platform metadata without following the workspace Git pointer", () => {
    const root = workspace("workspace-external-metadata");
    const platformGitDir = path.join(root, "platform.git");
    const attackerGitDir = path.join(root, "attacker.git");
    fs.renameSync(path.join(root, ".git"), platformGitDir);
    fs.mkdirSync(attackerGitDir);
    fs.writeFileSync(path.join(root, ".git"), `gitdir: ${attackerGitDir}\n`);

    const lease = acquireWorkspaceMutationLeaseSync({
      workspaceDir: root,
      gitDir: platformGitDir,
    });

    expect(lease).not.toBeNull();
    expect(fs.existsSync(path.join(platformGitDir, "octogee.workspace-mutation.lock"))).toBe(true);
    expect(fs.existsSync(path.join(attackerGitDir, "octogee.workspace-mutation.lock"))).toBe(false);
    lease?.release();
  });

  it("rejects a path without repository metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-not-git-"));
    roots.push(root);

    expect(() => acquireWorkspaceMutationLeaseSync({ workspaceDir: root })).toThrow(/git metadata/u);
  });
});
