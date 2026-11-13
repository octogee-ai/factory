import pg from "pg";
import type { PlatformStateStore } from "../store.js";
import { type NotificationTiming } from "./notifications.js";
import { type PlatformStateLogger, type PostgresRetryPolicy } from "./session.js";
import { type PostgresWatchTiming } from "./watch.js";
export interface PostgresPlatformStateStoreOptions {
    readonly pool: pg.Pool;
    readonly schema?: string;
    readonly retry?: Partial<PostgresRetryPolicy>;
    readonly watchTiming?: Partial<PostgresWatchTiming>;
    readonly notificationTiming?: Partial<NotificationTiming>;
    readonly logger?: PlatformStateLogger;
}
export declare function createPostgresPlatformStateStore(options: PostgresPlatformStateStoreOptions): PlatformStateStore;
