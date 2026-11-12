import { describe, expect, it } from "vitest";
import { formatListUsersLine } from "../ops/list-users.js";
import {
  NOTIFICATION_SMOKE_DISPLAY_NAME,
  NOTIFICATION_SMOKE_EMAIL,
  NOTIFICATION_SMOKE_PASSWORD,
} from "../product/ops/seed-test-notification-user.js";
import { parseSeedTypingPhrasesArgs } from "../ops/seed-typing-phrases.js";
import { TEST_TARGET } from "./fixtures/deployment.js";

describe("seed smoke-notification utilities", () => {
  it("seeds the fixed notification smoke identity", () => {
    expect(NOTIFICATION_SMOKE_EMAIL).toBe("notif-smoke@test.octogee.com");
    expect(NOTIFICATION_SMOKE_DISPLAY_NAME).toBe("Notif Smoke");
    expect(NOTIFICATION_SMOKE_PASSWORD).toContain("NotifTest");
  });

  it("parses seed typing phrase force mode and target project", () => {
    expect(parseSeedTypingPhrasesArgs([])).toEqual({ force: false, project: TEST_TARGET.firebaseProjectId });
    expect(parseSeedTypingPhrasesArgs(["--force", "--project=octogee"])).toEqual({
      force: true,
      project: "octogee",
    });
  });
});

describe("list-users", () => {
  it("formats the compact user list line", () => {
    expect(formatListUsersLine("uid-1", {
      onboardingComplete: true,
      workspaceSlug: "alice",
      email: "alice@example.com",
      selectedTier: "pro",
      provisioning: {
        openclaw: {
          status: "complete",
          activatedAgents: ["coach"],
        },
      },
    })).toContain("uid=uid-1");
  });
});
