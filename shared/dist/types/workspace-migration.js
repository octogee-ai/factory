export const WORKSPACE_MOVING_CODE = "workspace-moving";
export const WORKSPACE_MOVING_MESSAGE = "Moving your workspace — reconnecting shortly";
export const MIGRATION_QUIESCE_GRACE_MS = 20_000;
export const MIGRATION_QUIESCE_STOP_RECHECK_MS = 10_000;
export function readWorkspaceMigrationMarker(openclaw) {
    if (!openclaw || typeof openclaw !== "object")
        return null;
    const marker = openclaw.migration;
    if (!marker || typeof marker !== "object")
        return null;
    const { state, phase, operationId, startedAt } = marker;
    if ((state !== "moving" && state !== "preparing") || typeof startedAt !== "number" || !Number.isFinite(startedAt))
        return null;
    if (phase !== undefined && !["preparing", "waiting", "transferring", "connecting"].includes(String(phase)))
        return null;
    return { state, startedAt, ...(phase ? { phase: phase } : {}), ...(typeof operationId === "string" ? { operationId } : {}) };
}
