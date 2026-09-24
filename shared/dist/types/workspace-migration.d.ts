export declare const WORKSPACE_MOVING_CODE = "workspace-moving";
export declare const WORKSPACE_MOVING_MESSAGE = "Moving your workspace \u2014 back in a minute";
export declare const MIGRATION_QUIESCE_GRACE_MS = 20000;
export declare const MIGRATION_QUIESCE_STOP_RECHECK_MS = 10000;
export interface WorkspaceMigrationMarker {
    state: "moving";
    operationId?: string;
    startedAt: number;
}
export declare function readWorkspaceMigrationMarker(openclaw: unknown): WorkspaceMigrationMarker | null;
