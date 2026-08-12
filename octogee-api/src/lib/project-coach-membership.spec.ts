import { describe, expect, it, vi } from "vitest";

import { reconcileCoachProjectMembership } from "./project-coach-membership.js";

describe("reconcileCoachProjectMembership", () => {
  it("removes the workspace coach from every project channel", async () => {
    const call = vi.fn(async () => null);

    await reconcileCoachProjectMembership({
      coachMmUserId: "coach-mm",
      projectChannelIds: ["project-2", "project-1", "project-1"],
    }, call);

    expect(call.mock.calls).toEqual([
      ["DELETE", "/channels/project-1/members/coach-mm"],
      ["DELETE", "/channels/project-2/members/coach-mm"],
    ]);
  });

  it("treats an already-absent membership as converged and fails other errors", async () => {
    const absent = Object.assign(new Error("not found"), { status: 404 });
    await expect(reconcileCoachProjectMembership({
      coachMmUserId: "coach-mm",
      projectChannelIds: ["project-1"],
    }, vi.fn(async () => { throw absent; }))).resolves.toBeUndefined();

    await expect(reconcileCoachProjectMembership({
      coachMmUserId: "coach-mm",
      projectChannelIds: ["project-1"],
    }, vi.fn(async () => { throw new Error("Mattermost unavailable"); })))
      .rejects.toThrow("Mattermost unavailable");
  });
});
