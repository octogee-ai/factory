import { describe, expect, it } from "vitest";
import {
  parseReconcileCoachNamesArgs,
} from "../ops/reconcile-coach-names.js";
import {
  resolveRepairMissingProjectChannelsConfig,
} from "../ops/repair-missing-project-channels.js";

describe("repair-missing-project-channels config", () => {
  it("resolves dry-run defaults and Mattermost credentials from env", () => {
    expect(resolveRepairMissingProjectChannelsConfig(
      [],
      {
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json",
        MM_ADMIN_TOKEN: "token",
        MM_URL: "https://mattermost.test",
      },
    )).toEqual({
      apply: false,
      saKey: "/tmp/sa.json",
      mmUrl: "https://mattermost.test",
      mmAdminToken: "token",
    });
  });

  it("tracks --apply without requiring credentials during parse", () => {
    expect(resolveRepairMissingProjectChannelsConfig(["--apply"], {})).toMatchObject({
      apply: true,
      mmUrl: undefined,
      mmAdminToken: undefined,
    });
  });
});

describe("reconcile-coach-names args", () => {
  it("parses list/apply/clear modes and slug filters", () => {
    expect(parseReconcileCoachNamesArgs([
      "--list",
      "--apply",
      "--clear-onboarding-name",
      "alice",
      "uid-2",
    ], {
      GCLOUD_PROJECT: "octogee-test",
      MM_ADMIN_TOKEN: "token",
      MM_URL: "https://mattermost.test",
    })).toEqual({
      apply: true,
      list: true,
      clearOnboarding: true,
      filters: ["alice", "uid-2"],
      mmUrl: "https://mattermost.test",
      mmAdminToken: "token",
      saKey: undefined,
      projectId: "octogee-test",
    });
  });
});
