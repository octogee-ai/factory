import { describe, expect, it } from "vitest";

import {
  PROJECT_ARCHIVE_DAYS,
  PROJECT_ARCHIVE_WARNING_DAYS,
  parseProjectRetention,
  planProjectRetention,
  projectArchiveWarningDue,
} from "./project-retention.js";

const NOW = new Date("2026-07-23T16:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("planProjectRetention", () => {
  it("parses Firestore and JSON timestamp shapes into the canonical state", () => {
    expect(parseProjectRetention({
      schemaVersion: 1,
      status: "archived",
      archivedAt: { toDate: () => new Date("2026-07-01T00:00:00.000Z") },
      deleteAfter: { seconds: Date.parse("2026-09-29T00:00:00.000Z") / 1000 },
      warnedAt: null,
    })).toEqual({
      schemaVersion: 1,
      status: "archived",
      archivedAt: new Date("2026-07-01T00:00:00.000Z"),
      deleteAfter: new Date("2026-09-29T00:00:00.000Z"),
      warnedAt: null,
    });
    expect(parseProjectRetention({ schemaVersion: 1, status: "archived" })).toBeNull();
  });

  it("starts one immutable 90-day read archive when paid/trial project work ends", () => {
    expect(planProjectRetention(undefined, "archive_read", NOW)).toEqual({
      kind: "archive",
      state: {
        schemaVersion: 1,
        status: "archived",
        archivedAt: NOW,
        deleteAfter: new Date(NOW.getTime() + 90 * DAY_MS),
        warnedAt: null,
      },
    });
    expect(PROJECT_ARCHIVE_DAYS).toBe(90);
  });

  it("does not slide the deletion deadline on repeated sweeps", () => {
    const state = {
      schemaVersion: 1 as const,
      status: "archived" as const,
      archivedAt: new Date("2026-07-01T00:00:00.000Z"),
      deleteAfter: new Date("2026-09-29T00:00:00.000Z"),
      warnedAt: null,
    };
    expect(planProjectRetention(state, "archive_read", NOW)).toEqual({
      kind: "none",
      state,
    });
  });

  it("restores archived projects immediately when either paid ladder returns", () => {
    expect(planProjectRetention({
      schemaVersion: 1,
      status: "archived",
      archivedAt: new Date("2026-07-01T00:00:00.000Z"),
      deleteAfter: new Date("2026-09-29T00:00:00.000Z"),
      warnedAt: null,
    }, "active", NOW)).toEqual({
      kind: "restore",
      state: {
        schemaVersion: 1,
        status: "active",
        archivedAt: null,
        deleteAfter: null,
        warnedAt: null,
      },
    });
  });

  it("moves to deletion at the deadline but never while project work is entitled", () => {
    const expired = {
      schemaVersion: 1 as const,
      status: "archived" as const,
      archivedAt: new Date(NOW.getTime() - 90 * DAY_MS),
      deleteAfter: NOW,
      warnedAt: null,
    };
    expect(planProjectRetention(expired, "archive_read", NOW).kind).toBe("delete");
    expect(planProjectRetention(expired, "active", NOW).kind).toBe("restore");
  });

  it("keeps a completed deletion terminal until a new paid period begins", () => {
    const deleted = {
      schemaVersion: 1 as const,
      status: "deleted" as const,
      archivedAt: new Date(NOW.getTime() - 90 * DAY_MS),
      deleteAfter: NOW,
      warnedAt: new Date(NOW.getTime() - 7 * DAY_MS),
    };
    expect(planProjectRetention(deleted, "archive_read", NOW)).toEqual({
      kind: "none",
      state: deleted,
    });
    expect(planProjectRetention(deleted, "active", NOW).kind).toBe("restore");
  });

  it("does not reverse a deletion that was already claimed at the deadline", () => {
    const deleting = {
      schemaVersion: 1 as const,
      status: "deleting" as const,
      archivedAt: new Date(NOW.getTime() - 90 * DAY_MS),
      deleteAfter: NOW,
      warnedAt: new Date(NOW.getTime() - 7 * DAY_MS),
    };
    expect(planProjectRetention(deleting, "active", NOW)).toEqual({
      kind: "delete",
      state: deleting,
    });
  });
});

describe("projectArchiveWarningDue", () => {
  it("warns once seven days before deletion", () => {
    const state = {
      schemaVersion: 1 as const,
      status: "archived" as const,
      archivedAt: new Date(NOW.getTime() - 83 * DAY_MS),
      deleteAfter: new Date(NOW.getTime() + 7 * DAY_MS),
      warnedAt: null,
    };
    expect(PROJECT_ARCHIVE_WARNING_DAYS).toBe(7);
    expect(projectArchiveWarningDue(state, NOW)).toBe(true);
    expect(projectArchiveWarningDue({ ...state, warnedAt: NOW }, NOW)).toBe(false);
  });
});
