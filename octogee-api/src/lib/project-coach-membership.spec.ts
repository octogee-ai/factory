import { describe, expect, it, vi } from "vitest";

import { reconcileCoachProjectMembership } from "./project-coach-membership.js";

describe("reconcileCoachProjectMembership", () => {
  it("adds the scoped project agent alongside the workspace coach", async () => {
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
      ["GET", "/channels/project-1/members/coach-mm"],
      ["GET", "/channels/project-2/members/project-agent-mm"],
      ["POST", "/channels/project-2/members", { user_id: "project-agent-mm" }],
      ["GET", "/channels/project-2/members/coach-mm"],
    ]);
  });

  it("keeps existing scoped membership and keeps the coach in disabled-agent channels", async () => {
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
      ["GET", "/channels/disabled-project/members/coach-mm"],
      ["GET", "/channels/enabled-project/members/project-agent-mm"],
      ["GET", "/channels/enabled-project/members/coach-mm"],
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
      "GET",
      "/channels/project-1/members/coach-mm",
    );
  });

  it("adds missing coach membership and propagates upstream errors", async () => {
    const input = { coachMmUserId: "coach-mm", projects: [{ projectId: "orbit", projectAgentEnabled: false,
      projectAgentMmUserId: null, channelIds: ["project-1"] }] };
    const call = vi.fn(async (method: string) => {
      if (method === "GET") throw Object.assign(new Error("not found"), { status: 404 });
      return null;
    });
    await reconcileCoachProjectMembership(input, call);
    expect(call).toHaveBeenCalledWith("POST", "/channels/project-1/members", { user_id: "coach-mm" });
    await expect(reconcileCoachProjectMembership(input, vi.fn(async () => { throw new Error("Mattermost unavailable"); })))
      .rejects.toThrow("Mattermost unavailable");
  });
});
