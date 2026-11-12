export declare const WORKSPACE_MOVING_CODE = "workspace-moving";
export declare const WORKSPACE_MOVING_MESSAGE = "Moving your workspace \u2014 reconnecting shortly";
export declare const MIGRATION_QUIESCE_GRACE_MS = 20000;
export declare const MIGRATION_QUIESCE_STOP_RECHECK_MS = 10000;
declare const CONTROL_PHASES: readonly ["preparing", "waiting", "transferring", "connecting"];
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
export declare function readWorkspaceMigrationMarker(openclaw: unknown): WorkspaceMigrationMarker | null;
export declare function workspaceMigrationMessage(phase?: WorkspaceMigrationPhase | null): string;
export {};
