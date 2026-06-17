import { describe, it, expect } from "vitest";
import {
  WORKSPACE_REPO,
  SYSTEM_CONFIG_REPO,
  workspaceGiteaOrg,
  workspaceRepoName,
  systemConfigRepoName,
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

  it("system config repo is the fixed per-builder runtime-config repo", () => {
    expect(systemConfigRepoName()).toBe("system_config");
    expect(SYSTEM_CONFIG_REPO).toBe("system_config");
  });

  it("project repo is the bare project slug — org provides the namespace", () => {
    expect(projectRepoName("landing")).toBe("landing");
    expect(projectRepoName("landing")).not.toMatch(/^acme-/);
    expect(projectRepoName("landing")).not.toContain("-proj-");
  });
});
