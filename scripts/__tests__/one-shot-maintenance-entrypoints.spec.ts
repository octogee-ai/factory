import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHECK_USER_EMAIL,
  resolveCheckUserEmail,
} from "../ops/check-user.js";
import {
  isStaleSmokeDoc,
  parseCleanupStaleSmokeDocsArgs,
  STALE_SMOKE_DOC_AGE_MS,
} from "../ops/cleanup-stale-smoke-docs.js";
import {
  NOTIFICATION_SMOKE_CLEANUP_EMAIL,
  NOTIFICATION_SMOKE_USER_SUBCOLLECTIONS,
} from "../ops/cleanup-notif-smoke-user.js";
import { parseFirestoreAuditAction } from "../ops/firestore-audit.js";
import { formatListUsersLine } from "../ops/list-users.js";
import {
  NOTIFICATION_SMOKE_DISPLAY_NAME,
  NOTIFICATION_SMOKE_EMAIL,
  NOTIFICATION_SMOKE_PASSWORD,
} from "../ops/seed-test-notification-user.js";
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

  it("parses seed typing phrase force mode", () => {
    expect(parseSeedTypingPhrasesArgs([])).toEqual({ force: false });
    expect(parseSeedTypingPhrasesArgs(["--force"])).toEqual({ force: true });
  });
});

describe("cleanup-stale-smoke-docs helpers", () => {
  it("resolves project, service account, and dry-run mode from env", () => {
    expect(parseCleanupStaleSmokeDocsArgs(
      ["--dry-run"],
      {
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json",
        SMOKE_PROJECT: "octogee-dev",
      },
    )).toEqual({
      dryRun: true,
      project: "octogee-dev",
      saKey: "/tmp/sa.json",
    });
  });

  it("marks only old unprovisioned smoke docs as stale", () => {
    const nowMs = 10_000_000;
    const oldCreatedAt = { toMillis: () => nowMs - STALE_SMOKE_DOC_AGE_MS - 1 };
    const freshCreatedAt = { toMillis: () => nowMs - STALE_SMOKE_DOC_AGE_MS + 1 };

    expect(isStaleSmokeDoc({ createdAt: oldCreatedAt }, nowMs)).toBe(true);
    expect(isStaleSmokeDoc({ createdAt: freshCreatedAt }, nowMs)).toBe(false);
    expect(isStaleSmokeDoc({
      createdAt: oldCreatedAt,
      provisioning: { openclaw: { status: "complete" } },
    }, nowMs)).toBe(false);
  });
});

describe("small Firestore audit utilities", () => {
  it("parses audit actions and check-user email defaults", () => {
    expect(parseFirestoreAuditAction([])).toBe("audit");
    expect(parseFirestoreAuditAction(["clean"])).toBe("clean");
    expect(parseFirestoreAuditAction(["anything-else"])).toBe("audit");
    expect(resolveCheckUserEmail([])).toBe(DEFAULT_CHECK_USER_EMAIL);
    expect(resolveCheckUserEmail(["alice@example.com"])).toBe("alice@example.com");
  });

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
