export declare const WORKSPACE_MOVING_CODE = "workspace-moving";
export declare const WORKSPACE_MOVING_MESSAGE = "Moving your workspace \u2014 reconnecting shortly";
export declare const MIGRATION_QUIESCE_GRACE_MS = 20000;
export declare const MIGRATION_QUIESCE_STOP_RECHECK_MS = 10000;
export type WorkspaceMigrationPhase = "preparing" | "waiting" | "transferring" | "connecting";
export interface WorkspaceMigrationMarker {
    state: "preparing" | "moving";
    phase?: WorkspaceMigrationPhase;
    operationId?: string;
    startedAt: number;
}
export declare function readWorkspaceMigrationMarker(openclaw: unknown): WorkspaceMigrationMarker | null;
