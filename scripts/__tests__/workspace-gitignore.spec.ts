import { describe, expect, it } from "vitest";

import { workspaceGitignore } from "../lib/git.js";

describe("workspaceGitignore", () => {
  it("excludes project clones wholesale — project repos have their own commit path", () => {
    const content = workspaceGitignore();
    expect(content).toMatch(/^projects\/$/m);
    expect(content).not.toContain("projects/*/src");
  });

  it("keeps the provisioner-managed system files out of the workspace repo", () => {
    const content = workspaceGitignore();
    for (const line of ["PROJECTS.md", ".system/", ".openclaw/", ".ssh/", ".blobs/", "node_modules/"]) {
      expect(content).toContain(line);
    }
  });
});
