import type { ExpirySweepResult } from "../store.js";
import type { PostgresContext } from "./session.js";
export declare const CHANGE_LOG_RETENTION_MS: number;
export declare function sweepExpiredPostgresState(context: PostgresContext, now: number, limit: number): Promise<ExpirySweepResult>;
