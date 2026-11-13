import pg from "pg";
import { sweepExpiredPostgresState } from "./expiry.js";
import { DEFAULT_PLATFORM_STATE_SCHEMA } from "./migrate.js";
import { ChangeNotifications } from "./notifications.js";
import { createPostgresRepositories } from "./repositories.js";
import { DEFAULT_RETRY_POLICY, DirectPostgresSession, } from "./session.js";
import { runPostgresTransaction } from "./transaction.js";
import { DEFAULT_WATCH_TIMING, watchPostgres } from "./watch.js";
import { postgresWatchSource } from "./watch-sources.js";
const DEFAULT_NOTIFICATION_TIMING = { initialReconnectDelayMs: 250, maxReconnectDelayMs: 30_000 };
const CONSOLE_LOGGER = {
    warn: (message, detail) => console.warn(message, detail),
    error: (message, detail) => console.error(message, detail),
};
function transactionHandle(session) {
    return {
        ...createPostgresRepositories(session),
        label: session.attempt.label,
        readOnly: session.attempt.readOnly,
        attempt: session.attempt.attempt,
    };
}
export function createPostgresPlatformStateStore(options) {
    const context = {
        pool: options.pool,
        schema: pg.escapeIdentifier(options.schema ?? DEFAULT_PLATFORM_STATE_SCHEMA),
        retry: { ...DEFAULT_RETRY_POLICY, ...options.retry },
        logger: options.logger ?? CONSOLE_LOGGER,
    };
    const watchTiming = { ...DEFAULT_WATCH_TIMING, ...options.watchTiming };
    const notifications = new ChangeNotifications(context, { ...DEFAULT_NOTIFICATION_TIMING, ...options.notificationTiming });
    const subscriptions = new Set();
    return {
        ...createPostgresRepositories(new DirectPostgresSession(context, runPostgresTransaction)),
        transaction(transactionOptions, body) {
            return runPostgresTransaction(context, transactionOptions, (session) => body(transactionHandle(session)));
        },
        watch(request, listener) {
            const source = postgresWatchSource(request);
            const subscription = watchPostgres(source, listener, {
                context,
                notifications,
                timing: watchTiming,
                resumeFrom: request.resumeFrom,
                onSettled: () => subscriptions.delete(subscription),
            });
            subscriptions.add(subscription);
            return subscription;
        },
        sweepExpired(now, limit) {
            return sweepExpiredPostgresState(context, now, limit);
        },
        async close() {
            const results = await Promise.allSettled([...subscriptions].map((subscription) => subscription.close()));
            await notifications.close();
            const failure = results.find((result) => result.status === "rejected");
            if (failure !== undefined)
                throw failure.reason;
        },
    };
}
