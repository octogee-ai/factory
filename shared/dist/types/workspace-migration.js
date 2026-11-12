export const WORKSPACE_MOVING_CODE = "workspace-moving";
export const WORKSPACE_MOVING_MESSAGE = "Moving your workspace — reconnecting shortly";
export const MIGRATION_QUIESCE_GRACE_MS = 20_000;
export const MIGRATION_QUIESCE_STOP_RECHECK_MS = 10_000;
const CONTROL_PHASES = ["preparing", "waiting", "transferring", "connecting"];
function readMigrationActivity(state, phase, value) {
    if (state !== "moving" || phase !== "transferring")
        return undefined;
    return value === "activating" || value === "checkpointing" ? value : undefined;
}
export function readWorkspaceMigrationMarker(openclaw) {
    if (!openclaw || typeof openclaw !== "object")
        return null;
    const marker = openclaw.migration;
    if (!marker || typeof marker !== "object")
        return null;
    const { state, phase, activity: rawActivity, operationId, startedAt } = marker;
    if ((state !== "moving" && state !== "preparing") || typeof startedAt !== "number" || !Number.isFinite(startedAt))
        return null;
    const controlPhase = CONTROL_PHASES.find((candidate) => candidate === phase);
    if (phase !== undefined && controlPhase === undefined)
        return null;
    const activity = readMigrationActivity(state, controlPhase, rawActivity);
    return {
        state, startedAt,
        ...(controlPhase ? { phase: controlPhase } : {}),
        ...(activity ? { activity } : {}),
        ...(typeof operationId === "string" ? { operationId } : {}),
    };
}
const WORKSPACE_MIGRATION_MESSAGES = {
    preparing: "Preparing to move your workspace",
    waiting: "Waiting for active work to finish before moving your workspace",
    transferring: "Moving your workspace data",
    activating: "Starting your workspace on the new gateway",
    checkpointing: "Saving your computer state",
    connecting: "Reconnecting to your workspace",
};
export function workspaceMigrationMessage(phase) {
    return phase ? WORKSPACE_MIGRATION_MESSAGES[phase] : WORKSPACE_MOVING_MESSAGE;
}
