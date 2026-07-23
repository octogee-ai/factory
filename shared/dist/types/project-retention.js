export const PROJECT_ARCHIVE_DAYS = 90;
export const PROJECT_ARCHIVE_WARNING_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
function asDate(value) {
    if (value instanceof Date)
        return Number.isFinite(value.getTime()) ? value : null;
    if (typeof value === "number" && Number.isFinite(value))
        return new Date(value);
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? new Date(parsed) : null;
    }
    if (!value || typeof value !== "object")
        return null;
    const timestamp = value;
    if (typeof timestamp.toDate === "function")
        return timestamp.toDate();
    if (typeof timestamp.toMillis === "function")
        return new Date(timestamp.toMillis());
    const seconds = timestamp.seconds ?? timestamp._seconds;
    return typeof seconds === "number" && Number.isFinite(seconds)
        ? new Date(seconds * 1000)
        : null;
}
function isProjectRetentionStatus(value) {
    return value === "active" ||
        value === "archived" ||
        value === "deleting" ||
        value === "deleted";
}
function retentionDates(raw) {
    const archivedAt = raw.archivedAt === null ? null : asDate(raw.archivedAt);
    const deleteAfter = raw.deleteAfter === null ? null : asDate(raw.deleteAfter);
    const warnedAt = raw.warnedAt === null ? null : asDate(raw.warnedAt);
    if (archivedAt === null && raw.archivedAt !== null ||
        deleteAfter === null && raw.deleteAfter !== null ||
        warnedAt === null && raw.warnedAt !== null) {
        return null;
    }
    return { archivedAt, deleteAfter, warnedAt };
}
function statusRequiresArchiveDates(status) {
    return status === "archived" || status === "deleting" || status === "deleted";
}
export function parseProjectRetention(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const raw = value;
    if (raw.schemaVersion !== 1 || !isProjectRetentionStatus(raw.status))
        return null;
    const dates = retentionDates(raw);
    if (!dates)
        return null;
    if (statusRequiresArchiveDates(raw.status) && (!dates.archivedAt || !dates.deleteAfter)) {
        return null;
    }
    return {
        schemaVersion: 1,
        status: raw.status,
        ...dates,
    };
}
function activeState() {
    return {
        schemaVersion: 1,
        status: "active",
        archivedAt: null,
        deleteAfter: null,
        warnedAt: null,
    };
}
function deletingState(state) {
    return { ...state, status: "deleting" };
}
export function planProjectRetention(current, projectMode, now = new Date()) {
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
export function projectArchiveWarningDue(state, now = new Date()) {
    if (state.status !== "archived" || state.warnedAt !== null || state.deleteAfter === null) {
        return false;
    }
    const warningAt = state.deleteAfter.getTime() - PROJECT_ARCHIVE_WARNING_DAYS * DAY_MS;
    return now.getTime() >= warningAt && now.getTime() < state.deleteAfter.getTime();
}
