export const WORKSPACE_MOVING_CODE = "workspace-moving";
export const WORKSPACE_MOVING_MESSAGE = "Moving your workspace — reconnecting shortly";

export const MIGRATION_QUIESCE_GRACE_MS = 20_000;
export const MIGRATION_QUIESCE_STOP_RECHECK_MS = 10_000;

const CONTROL_PHASES = ["preparing", "waiting", "transferring", "connecting"] as const;
type WorkspaceMigrationControlPhase = typeof CONTROL_PHASES[number];
type WorkspaceMigrationActivity = "activating" | "checkpointing";
export type WorkspaceMigrationPhase = WorkspaceMigrationControlPhase | WorkspaceMigrationActivity;

export interface WorkspaceMigrationMarker {
  state: "preparing" | "moving";
  phase?: WorkspaceMigrationControlPhase;
  activity?: WorkspaceMigrationActivity;
  operationId?: string;
  startedAt: number;
}

function readMigrationActivity(state: WorkspaceMigrationMarker["state"], phase: WorkspaceMigrationControlPhase | undefined, value: unknown): WorkspaceMigrationActivity | undefined {
  if (state !== "moving" || phase !== "transferring") return undefined;
  return value === "activating" || value === "checkpointing" ? value : undefined;
}

export function readWorkspaceMigrationMarker(openclaw: unknown): WorkspaceMigrationMarker | null {
  if (!openclaw || typeof openclaw !== "object") return null;
  const marker = (openclaw as { migration?: unknown }).migration;
  if (!marker || typeof marker !== "object") return null;
  const { state, phase, activity: rawActivity, operationId, startedAt } = marker as Record<string, unknown>;
  if ((state !== "moving" && state !== "preparing") || typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  const controlPhase = CONTROL_PHASES.find((candidate) => candidate === phase);
  if (phase !== undefined && controlPhase === undefined) return null;
  const activity = readMigrationActivity(state, controlPhase, rawActivity);
  return {
    state, startedAt,
    ...(controlPhase ? { phase: controlPhase } : {}),
    ...(activity ? { activity } : {}),
    ...(typeof operationId === "string" ? { operationId } : {}),
  };
}

const WORKSPACE_MIGRATION_MESSAGES: Record<WorkspaceMigrationPhase, string> = {
  preparing: "Preparing to move your workspace",
  waiting: "Waiting for active work to finish before moving your workspace",
  transferring: "Moving your workspace data",
  activating: "Starting your workspace on the new gateway",
  checkpointing: "Saving your computer state",
  connecting: "Reconnecting to your workspace",
};

export function workspaceMigrationMessage(phase?: WorkspaceMigrationPhase | null): string {
  return phase ? WORKSPACE_MIGRATION_MESSAGES[phase] : WORKSPACE_MOVING_MESSAGE;
}
