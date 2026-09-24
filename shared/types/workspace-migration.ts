export const WORKSPACE_MOVING_CODE = "workspace-moving";
export const WORKSPACE_MOVING_MESSAGE = "Moving your workspace — back in a minute";

export const MIGRATION_QUIESCE_GRACE_MS = 20_000;
export const MIGRATION_QUIESCE_STOP_RECHECK_MS = 10_000;

export interface WorkspaceMigrationMarker {
  state: "moving";
  operationId?: string;
  startedAt: number;
}

export function readWorkspaceMigrationMarker(openclaw: unknown): WorkspaceMigrationMarker | null {
  if (!openclaw || typeof openclaw !== "object") return null;
  const marker = (openclaw as { migration?: unknown }).migration;
  if (!marker || typeof marker !== "object") return null;
  const { state, operationId, startedAt } = marker as Record<string, unknown>;
  if (state !== "moving" || typeof startedAt !== "number") return null;
  return { state, startedAt, ...(typeof operationId === "string" ? { operationId } : {}) };
}
