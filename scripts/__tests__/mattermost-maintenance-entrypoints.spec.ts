import { describe, expect, it } from "vitest";
import {
  parseReconcileDefaultAgentNamesArgs,
} from "../ops/reconcile-default-agent-names.js";
import {
  resolveRepairMissingProjectChannelsConfig,
} from "../ops/repair-missing-project-channels.js";
import { TEST_TARGET } from "./fixtures/deployment.js";

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
      project: TEST_TARGET.firebaseProjectId,
      mmUrl: "https://mattermost.test",
      mmAdminToken: "token",
    });
  });

  it("tracks --apply and --project without requiring credentials during parse", () => {
    expect(resolveRepairMissingProjectChannelsConfig(["--apply", "--project=octogee"], {})).toEqual({
      apply: true,
      project: "octogee",
      mmUrl: undefined,
      mmAdminToken: undefined,
    });
  });
});

describe("reconcile-coach-names args", () => {
  it("parses list/apply/clear modes and slug filters", () => {
    expect(parseReconcileDefaultAgentNamesArgs([
      "--list",
      "--apply",
      "--clear-onboarding-name",
      "alice",
      "uid-2",
    ], {
      GCLOUD_PROJECT: TEST_TARGET.firebaseProjectId,
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
      projectId: TEST_TARGET.firebaseProjectId,
    });
  });
});
