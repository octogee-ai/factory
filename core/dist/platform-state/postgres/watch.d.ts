import type { WatchAggregate, WatchCursor, WatchListener, WatchSubscription } from "../store.js";
import type { ChangeNotifications } from "./notifications.js";
import type { PostgresContext } from "./session.js";
import type { PostgresWatchSource } from "./watch-sources.js";
export interface PostgresWatchTiming {
    readonly pollIntervalMs: number;
    readonly initialRetryDelayMs: number;
    readonly maxRetryDelayMs: number;
}
export declare const DEFAULT_WATCH_TIMING: PostgresWatchTiming;
export interface PostgresWatchOptions {
    readonly context: PostgresContext;
    readonly notifications: ChangeNotifications;
    readonly timing: PostgresWatchTiming;
    readonly resumeFrom?: WatchCursor;
    readonly onSettled: () => void;
}
export declare function watchPostgres<A extends WatchAggregate>(source: PostgresWatchSource<A>, listener: WatchListener<A>, options: PostgresWatchOptions): WatchSubscription;
