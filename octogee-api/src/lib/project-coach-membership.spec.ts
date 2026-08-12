import { describe, expect, it, vi } from "vitest";

import { reconcileCoachProjectMembership } from "./project-coach-membership.js";

describe("reconcileCoachProjectMembership", () => {
  it("adds the scoped project agent before removing the workspace coach", async () => {
    const call = vi.fn(async (method: string, path: string) => {
      if (method === "GET" && path.endsWith("/members/project-agent-mm")) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      return null;
    });

    await reconcileCoachProjectMembership({
      coachMmUserId: "coach-mm",
      projects: [{
        projectId: "orbit",
        projectAgentEnabled: true,
        projectAgentMmUserId: "project-agent-mm",
        channelIds: ["project-2", "project-1", "project-1"],
      }],
    }, call);

    expect(call.mock.calls).toEqual([
      ["GET", "/channels/project-1/members/project-agent-mm"],
      ["POST", "/channels/project-1/members", { user_id: "project-agent-mm" }],
      ["DELETE", "/channels/project-1/members/coach-mm"],
      ["GET", "/channels/project-2/members/project-agent-mm"],
      ["POST", "/channels/project-2/members", { user_id: "project-agent-mm" }],
      ["DELETE", "/channels/project-2/members/coach-mm"],
    ]);
  });

  it("keeps existing scoped membership and removes the coach from disabled-agent channels", async () => {
    const call = vi.fn(async () => null);

    await reconcileCoachProjectMembership({
      coachMmUserId: "coach-mm",
      projects: [
        {
          projectId: "app",
          projectAgentEnabled: false,
          projectAgentMmUserId: null,
          channelIds: ["disabled-project"],
        },
        {
          projectId: "orbit",
          projectAgentEnabled: true,
          projectAgentMmUserId: "project-agent-mm",
          channelIds: ["enabled-project"],
        },
      ],
    }, call);

    expect(call.mock.calls).toEqual([
      ["DELETE", "/channels/disabled-project/members/coach-mm"],
      ["GET", "/channels/enabled-project/members/project-agent-mm"],
      ["DELETE", "/channels/enabled-project/members/coach-mm"],
    ]);
  });

  it("fails closed when an enabled project agent has not been minted yet", async () => {
    const call = vi.fn(async () => null);

    await expect(reconcileCoachProjectMembership({
      coachMmUserId: "coach-mm",
      projects: [{
        projectId: "orbit",
        projectAgentEnabled: true,
        projectAgentMmUserId: null,
        channelIds: ["project-1"],
      }],
    }, call)).rejects.toThrow("enabled project agents are not ready: orbit");

    expect(call).toHaveBeenCalledWith(
      "DELETE",
      "/channels/project-1/members/coach-mm",
    );
  });

  it("treats an already-absent membership as converged and fails other errors", async () => {
    const absent = Object.assign(new Error("not found"), { status: 404 });
    await expect(reconcileCoachProjectMembership({
      coachMmUserId: "coach-mm",
      projects: [{
        projectId: "orbit",
        projectAgentEnabled: false,
        projectAgentMmUserId: null,
        channelIds: ["project-1"],
      }],
    }, vi.fn(async () => { throw absent; }))).resolves.toBeUndefined();

    await expect(reconcileCoachProjectMembership({
      coachMmUserId: "coach-mm",
      projects: [{
        projectId: "orbit",
        projectAgentEnabled: false,
        projectAgentMmUserId: null,
        channelIds: ["project-1"],
      }],
    }, vi.fn(async () => { throw new Error("Mattermost unavailable"); })))
      .rejects.toThrow("Mattermost unavailable");
  });
});
