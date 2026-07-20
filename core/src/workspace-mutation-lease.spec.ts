import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireWorkspaceMutationLeaseSync,
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

  it("does not couple independent customer workspaces", () => {
    const firstRoot = workspace("workspace-one");
    const secondRoot = workspace("workspace-two");
    const first = acquireWorkspaceMutationLeaseSync({ workspaceDir: firstRoot });
    const second = acquireWorkspaceMutationLeaseSync({ workspaceDir: secondRoot });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    first?.release();
    second?.release();
  });

  it("rejects a path without repository metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-not-git-"));
    roots.push(root);

    expect(() => acquireWorkspaceMutationLeaseSync({ workspaceDir: root })).toThrow(/git metadata/u);
  });
});
