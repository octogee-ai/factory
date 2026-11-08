import { describe, expect, it } from "vitest";

import type { WorkspaceProject } from "@octogee/core/platform-state";

import { isRunnableProject, isRunnableWorkspaceProject } from "./active-project.js";

const ACTIVE = {
  ownerUid: "owner-1",
  ownerActive: true,
  status: "building",
  provisioningState: "active",
};

describe("isRunnableProject", () => {
  it("accepts only a fully active canonical project", () => {
    expect(isRunnableProject(ACTIVE, "owner-1")).toBe(true);
  });

  it.each([
    ["wrong owner", { ownerUid: "other" }],
    ["missing status", { status: undefined }],
    ["unknown status", { status: "ready" }],
    ["archived", { status: "archived" }],
    ["missing provisioning", { provisioningState: undefined }],
    ["provisioning", { provisioningState: "provisioning" }],
    ["failed", { provisioningState: "failed" }],
    ["commercial archive", { commercialLifecycle: { status: "archived" } }],
    ["retention archive", { retention: { status: "archived" } }],
    ["retention deleting", { retention: { status: "deleting" } }],
    ["retention deleted", { retention: { status: "deleted" } }],
  ])("rejects %s", (_label, patch) => {
    expect(isRunnableProject({ ...ACTIVE, ...patch }, "owner-1")).toBe(false);
  });
});

const ACTIVE_RECORD: WorkspaceProject = {
  workspaceSlug: "mira",
  projectSlug: "orbit",
  ownerUid: "owner-1",
  ownerActive: true,
  giteaRepoName: "mira-orbit",
  provisioningState: "active",
  provisioningError: null,
  pendingVisibility: null,
  visibility: "private",
  checkoutEnabled: null,
  status: "building",
  archived: null,
  archivedAt: null,
  commercialLifecycleStatus: null,
  repoSource: null,
  agent: null,
  updatedAt: null,
};

describe("isRunnableWorkspaceProject", () => {
  it.each([
    ["no commercial lifecycle", {}],
    ["an active commercial lifecycle", { commercialLifecycleStatus: "active" }],
  ])("accepts a fully active project with %s", (_label, patch) => {
    expect(isRunnableWorkspaceProject({ ...ACTIVE_RECORD, ...patch }, "owner-1")).toBe(true);
  });

  it.each([
    ["wrong owner", { ownerUid: "other" }],
    ["inactive owner", { ownerActive: false }],
    ["unrecorded owner activity", { ownerActive: null }],
    ["missing status", { status: null }],
    ["unknown status", { status: "ready" }],
    ["archived", { status: "archived" }],
    ["missing provisioning", { provisioningState: null }],
    ["provisioning", { provisioningState: "provisioning" }],
    ["failed", { provisioningState: "failed" }],
    ["commercial archive", { commercialLifecycleStatus: "archived" }],
  ])("rejects %s", (_label, patch) => {
    expect(isRunnableWorkspaceProject({ ...ACTIVE_RECORD, ...patch }, "owner-1")).toBe(false);
  });
});
