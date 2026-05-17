import { describe, it, expect } from "vitest";
import {
  WORKSPACE_REPO,
  workspaceGiteaOrg,
  workspaceRepoName,
  projectRepoName,
} from "../lib/gitea-naming.js";

describe("gitea-naming", () => {
  it("org is the bare workspace slug (1:1 with MM team)", () => {
    expect(workspaceGiteaOrg("acme")).toBe("acme");
  });

  it("workspace repo is the bare name 'workspace' — no slug prefix", () => {
    expect(workspaceRepoName()).toBe("workspace");
    expect(WORKSPACE_REPO).toBe("workspace");
    expect(workspaceRepoName()).not.toContain("acme");
  });

  it("project repo is the bare project slug — org provides the namespace", () => {
    expect(projectRepoName("landing")).toBe("landing");
    expect(projectRepoName("landing")).not.toMatch(/^acme-/);
    expect(projectRepoName("landing")).not.toContain("-proj-");
  });
});
