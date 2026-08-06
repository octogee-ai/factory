import { describe, expect, it } from "vitest";

import { isRunnableProject } from "./active-project.js";

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
