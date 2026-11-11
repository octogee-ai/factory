import { describe, expect, it } from "vitest";
import {
  isStaleSmokeDoc,
  parseCleanupStaleSmokeDocsArgs,
  STALE_SMOKE_DOC_AGE_MS,
} from "../ops/cleanup-stale-smoke-docs.js";
import {
  NOTIFICATION_SMOKE_CLEANUP_EMAIL,
  NOTIFICATION_SMOKE_USER_SUBCOLLECTIONS,
} from "../product/ops/cleanup-notif-smoke-user.js";
import { formatListUsersLine } from "../ops/list-users.js";
import {
  NOTIFICATION_SMOKE_DISPLAY_NAME,
  NOTIFICATION_SMOKE_EMAIL,
  NOTIFICATION_SMOKE_PASSWORD,
} from "../product/ops/seed-test-notification-user.js";
import { parseSeedTypingPhrasesArgs } from "../ops/seed-typing-phrases.js";

describe("seed and cleanup smoke-notification utilities", () => {
  it("shares the fixed test identity between seed and cleanup scripts", () => {
    expect(NOTIFICATION_SMOKE_EMAIL).toBe("notif-smoke@test.octogee.com");
    expect(NOTIFICATION_SMOKE_CLEANUP_EMAIL).toBe(NOTIFICATION_SMOKE_EMAIL);
    expect(NOTIFICATION_SMOKE_DISPLAY_NAME).toBe("Notif Smoke");
    expect(NOTIFICATION_SMOKE_PASSWORD).toContain("NotifTest");
    expect(NOTIFICATION_SMOKE_USER_SUBCOLLECTIONS).toEqual([
      "inbox",
      "system",
      "pushSubscriptions",
      "preferences",
      "engagement",
    ]);
  });

  it("parses seed typing phrase force mode and target project", () => {
    expect(parseSeedTypingPhrasesArgs([])).toEqual({ force: false, project: "octogee-test" });
    expect(parseSeedTypingPhrasesArgs(["--force", "--project=octogee"])).toEqual({
      force: true,
      project: "octogee",
    });
  });
});

describe("cleanup-stale-smoke-docs helpers", () => {
  it("resolves project and dry-run mode, leaving credentials to application default", () => {
    expect(parseCleanupStaleSmokeDocsArgs(
      ["--dry-run"],
      {
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json",
        SMOKE_PROJECT: "octogee-dev",
      },
    )).toEqual({
      dryRun: true,
      project: "octogee-dev",
    });
    expect(parseCleanupStaleSmokeDocsArgs([], {})).toEqual({
      dryRun: false,
      project: "octogee-test",
    });
  });

  it("marks only old unprovisioned smoke docs as stale", () => {
    const nowMs = 10_000_000;
    const oldCreatedAt = { toMillis: () => nowMs - STALE_SMOKE_DOC_AGE_MS - 1 };
    const freshCreatedAt = { toMillis: () => nowMs - STALE_SMOKE_DOC_AGE_MS + 1 };

    expect(isStaleSmokeDoc({ createdAt: oldCreatedAt }, nowMs)).toBe(false);
    expect(isStaleSmokeDoc({ acceptanceSmoke: true, createdAt: oldCreatedAt }, nowMs)).toBe(true);
    expect(isStaleSmokeDoc({ acceptanceSmoke: true, createdAt: freshCreatedAt }, nowMs)).toBe(false);
    expect(isStaleSmokeDoc({ acceptanceSmoke: true }, nowMs)).toBe(false);
    expect(isStaleSmokeDoc({
      acceptanceSmoke: true,
      createdAt: oldCreatedAt,
      provisioning: { openclaw: { status: "complete" } },
    }, nowMs)).toBe(false);
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
