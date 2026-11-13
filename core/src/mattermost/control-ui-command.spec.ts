import { describe, expect, it, vi } from "vitest";
import { controlUiCommandUrl, convergeControlUiCommands } from "./control-ui-command.js";

const URL = controlUiCommandUrl("octogee-test");

describe("/ui command", () => {
  it("posts to the in-cluster Mattermost callback router that Mattermost is allowed to reach", () => {
    expect(URL).toBe(
      "http://mattermost-callback-router.octogee-test.svc.cluster.local:3001/internal/mattermost/commands/control-ui",
    );
    expect(() => controlUiCommandUrl(undefined)).toThrow(/K8S_NAMESPACE/);
    expect(() => controlUiCommandUrl("evil.example.com/")).toThrow(/K8S_NAMESPACE/);
  });

  it("registers /ui in every workspace team, skips other teams, and keeps going past a failing team", async () => {
    const ensureCommand = vi.fn(async (spec: { teamId: string }) => {
      if (spec.teamId === "team-broken") throw new Error("mm POST /commands failed: 500");
      return spec.teamId === "team-new" ? "created" as const : "present" as const;
    });
    const log = vi.fn();

    const summary = await convergeControlUiCommands({
      host: { listTeamIds: async () => ["team-new", "team-ops", "team-broken", "team-old"], ensureCommand },
      url: URL,
      isWorkspaceTeam: async (teamId) => teamId !== "team-ops",
      log,
    });

    expect(summary).toEqual({ created: 1, updated: 0, present: 1, skipped: 1, failed: 1 });
    expect(ensureCommand.mock.calls.map(([spec]) => spec)).toEqual(
      ["team-new", "team-broken", "team-old"].map((teamId) => expect.objectContaining({ teamId, trigger: "ui", url: URL })),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("/ui command convergence failed"), {
      teamId: "team-broken",
      error: "mm POST /commands failed: 500",
    });
  });
});
