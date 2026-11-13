import type { Router } from "express";
import { type LogEntriesSource } from "./fleet-logs.js";
export interface AdminLogsDeps {
    readonly source: LogEntriesSource | null;
    readonly namespace: string;
    readonly logger: {
        warn(message: string, meta?: Record<string, unknown>): void;
    };
    readonly now?: () => number;
    readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
export declare function addAdminLogsRoutes(router: Router, deps: AdminLogsDeps): Router;
