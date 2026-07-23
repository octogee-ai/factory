import type { ProjectCommercialMode } from "./commercial-entitlements.js";

export const PROJECT_ARCHIVE_DAYS = 90;
export const PROJECT_ARCHIVE_WARNING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ProjectRetentionStatus = "active" | "archived" | "deleting" | "deleted";

export interface ProjectRetentionState {
  schemaVersion: 1;
  status: ProjectRetentionStatus;
  archivedAt: Date | null;
  deleteAfter: Date | null;
  warnedAt: Date | null;
}

export type ProjectRetentionPlan =
  | { kind: "none"; state: ProjectRetentionState }
  | { kind: "archive"; state: ProjectRetentionState }
  | { kind: "restore"; state: ProjectRetentionState }
  | { kind: "delete"; state: ProjectRetentionState };

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  }
  if (!value || typeof value !== "object") return null;
  const timestamp = value as {
    toDate?: () => Date;
    toMillis?: () => number;
    seconds?: unknown;
    _seconds?: unknown;
  };
  if (typeof timestamp.toDate === "function") return timestamp.toDate();
  if (typeof timestamp.toMillis === "function") return new Date(timestamp.toMillis());
  const seconds = timestamp.seconds ?? timestamp._seconds;
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000)
    : null;
}

function isProjectRetentionStatus(value: unknown): value is ProjectRetentionStatus {
  return value === "active" ||
    value === "archived" ||
    value === "deleting" ||
    value === "deleted";
}

function retentionDates(raw: Record<string, unknown>): {
  archivedAt: Date | null;
  deleteAfter: Date | null;
  warnedAt: Date | null;
} | null {
  const archivedAt = raw.archivedAt === null ? null : asDate(raw.archivedAt);
  const deleteAfter = raw.deleteAfter === null ? null : asDate(raw.deleteAfter);
  const warnedAt = raw.warnedAt === null ? null : asDate(raw.warnedAt);
  if (
    archivedAt === null && raw.archivedAt !== null ||
    deleteAfter === null && raw.deleteAfter !== null ||
    warnedAt === null && raw.warnedAt !== null
  ) {
    return null;
  }
  return { archivedAt, deleteAfter, warnedAt };
}

function statusRequiresArchiveDates(status: ProjectRetentionStatus): boolean {
  return status === "archived" || status === "deleting" || status === "deleted";
}

export function parseProjectRetention(value: unknown): ProjectRetentionState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || !isProjectRetentionStatus(raw.status)) return null;
  const dates = retentionDates(raw);
  if (!dates) return null;
  if (statusRequiresArchiveDates(raw.status) && (!dates.archivedAt || !dates.deleteAfter)) {
    return null;
  }
  return {
    schemaVersion: 1,
    status: raw.status,
    ...dates,
  };
}

function activeState(): ProjectRetentionState {
  return {
    schemaVersion: 1,
    status: "active",
    archivedAt: null,
    deleteAfter: null,
    warnedAt: null,
  };
}

function deletingState(state: ProjectRetentionState): ProjectRetentionState {
  return { ...state, status: "deleting" };
}

export function planProjectRetention(
  current: ProjectRetentionState | null | undefined,
  projectMode: ProjectCommercialMode,
  now: Date = new Date(),
): ProjectRetentionPlan {
  if (current?.status === "deleting") {
    return { kind: "delete", state: current };
  }
  if (projectMode === "active") {
    if (!current || current.status === "active") {
      return { kind: "none", state: current ?? activeState() };
    }
    return { kind: "restore", state: activeState() };
  }

  if (!current || current.status === "active") {
    return {
      kind: "archive",
      state: {
        schemaVersion: 1,
        status: "archived",
        archivedAt: now,
        deleteAfter: new Date(now.getTime() + PROJECT_ARCHIVE_DAYS * DAY_MS),
        warnedAt: null,
      },
    };
  }

  if (current.status === "deleted") {
    return { kind: "none", state: current };
  }

  if (current.deleteAfter !== null && current.deleteAfter.getTime() <= now.getTime()) {
    return { kind: "delete", state: deletingState(current) };
  }

  return { kind: "none", state: current };
}

export function projectArchiveWarningDue(
  state: ProjectRetentionState,
  now: Date = new Date(),
): boolean {
  if (state.status !== "archived" || state.warnedAt !== null || state.deleteAfter === null) {
    return false;
  }
  const warningAt = state.deleteAfter.getTime() - PROJECT_ARCHIVE_WARNING_DAYS * DAY_MS;
  return now.getTime() >= warningAt && now.getTime() < state.deleteAfter.getTime();
}
