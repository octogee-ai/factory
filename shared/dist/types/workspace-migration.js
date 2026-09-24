export const WORKSPACE_MOVING_CODE = "workspace-moving";
export const WORKSPACE_MOVING_MESSAGE = "Moving your workspace — back in a minute";
export const MIGRATION_QUIESCE_GRACE_MS = 20_000;
export const MIGRATION_QUIESCE_STOP_RECHECK_MS = 10_000;
export function readWorkspaceMigrationMarker(openclaw) {
    if (!openclaw || typeof openclaw !== "object")
        return null;
    const marker = openclaw.migration;
    if (!marker || typeof marker !== "object")
        return null;
    const { state, operationId, startedAt } = marker;
    if (state !== "moving" || typeof startedAt !== "number")
        return null;
    return { state, startedAt, ...(typeof operationId === "string" ? { operationId } : {}) };
}
