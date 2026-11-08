import type { ProjectAccessMode } from "./user-entitlements.js";
export declare const PROJECT_ARCHIVE_DAYS = 90;
export declare const PROJECT_ARCHIVE_WARNING_DAYS = 7;
export type ProjectRetentionStatus = "active" | "archived" | "deleting" | "deleted";
export interface ProjectRetentionState {
    schemaVersion: 1;
    status: ProjectRetentionStatus;
    archivedAt: Date | null;
    deleteAfter: Date | null;
    warnedAt: Date | null;
}
export type ProjectRetentionPlan = {
    kind: "none";
    state: ProjectRetentionState;
} | {
    kind: "archive";
    state: ProjectRetentionState;
} | {
    kind: "restore";
    state: ProjectRetentionState;
} | {
    kind: "delete";
    state: ProjectRetentionState;
};
export declare function parseProjectRetention(value: unknown): ProjectRetentionState | null;
export declare function planProjectRetention(current: ProjectRetentionState | null | undefined, projectMode: ProjectAccessMode, now?: Date): ProjectRetentionPlan;
export declare function projectArchiveWarningDue(state: ProjectRetentionState, now?: Date): boolean;
