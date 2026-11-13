export declare class FleetLogsQueryError extends Error {
}
export interface FleetLogsQuery {
    readonly level: string;
    readonly services?: string[];
    readonly users?: string[];
    readonly gatewayId?: string;
    readonly migrationId?: string;
    readonly sinceMs: number;
    readonly follow: boolean;
}
export interface FleetLogEntry {
    readonly timestamp: string;
    readonly severity: string;
    readonly service: string;
    readonly instance: string;
    readonly gatewayId?: string;
    readonly user?: string;
    readonly category?: string;
    readonly status?: string;
    readonly message: string;
    readonly details: Record<string, unknown>;
}
export interface LogEntriesRequest {
    readonly filter: string;
    readonly orderBy: "timestamp asc" | "timestamp desc";
    readonly pageSize: number;
    readonly pageToken?: string;
}
export interface LogEntriesPage {
    readonly entries: readonly unknown[];
    readonly nextPageToken?: string;
}
export interface LogEntriesSource {
    list(request: LogEntriesRequest, signal: AbortSignal): Promise<LogEntriesPage>;
}
export declare function parseFleetLogsQuery(query: Record<string, unknown>): FleetLogsQuery;
export declare function buildFleetLogsFilter(input: {
    namespace: string;
    gatewayId?: string;
    migrationId?: string;
}): string;
export declare function normalizeFleetLog(value: unknown): FleetLogEntry;
export interface StreamFleetLogsInput {
    readonly source: LogEntriesSource;
    readonly namespace: string;
    readonly query: FleetLogsQuery;
    readonly signal: AbortSignal;
    readonly now: () => number;
    readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    readonly onStart: () => void;
    readonly write: (entry: FleetLogEntry) => Promise<void>;
}
export declare function streamFleetLogs(input: StreamFleetLogsInput): Promise<void>;
