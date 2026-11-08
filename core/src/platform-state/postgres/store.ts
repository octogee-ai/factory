import pg from "pg";
import type { PlatformStateStore, PlatformStateTransaction, WatchSubscription } from "../store.js";
import { sweepExpiredPostgresState } from "./expiry.js";
import { DEFAULT_PLATFORM_STATE_SCHEMA } from "./migrate.js";
import { ChangeNotifications, type NotificationTiming } from "./notifications.js";
import { createPostgresRepositories } from "./repositories.js";
import {
  DEFAULT_RETRY_POLICY,
  DirectPostgresSession,
  type PlatformStateLogger,
  type PostgresContext,
  type PostgresRetryPolicy,
  type TransactionPostgresSession,
} from "./session.js";
import { runPostgresTransaction } from "./transaction.js";
import { DEFAULT_WATCH_TIMING, watchPostgres, type PostgresWatchTiming } from "./watch.js";
import { postgresWatchSource } from "./watch-sources.js";

export interface PostgresPlatformStateStoreOptions {
  readonly pool: pg.Pool;
  readonly schema?: string;
  readonly retry?: Partial<PostgresRetryPolicy>;
  readonly watchTiming?: Partial<PostgresWatchTiming>;
  readonly notificationTiming?: Partial<NotificationTiming>;
  readonly logger?: PlatformStateLogger;
}

const DEFAULT_NOTIFICATION_TIMING: NotificationTiming = { initialReconnectDelayMs: 250, maxReconnectDelayMs: 30_000 };

const CONSOLE_LOGGER: PlatformStateLogger = {
  warn: (message, detail) => console.warn(message, detail),
  error: (message, detail) => console.error(message, detail),
};

function transactionHandle(session: TransactionPostgresSession): PlatformStateTransaction {
  return {
    ...createPostgresRepositories(session),
    label: session.attempt.label,
    readOnly: session.attempt.readOnly,
    attempt: session.attempt.attempt,
  };
}

export function createPostgresPlatformStateStore(options: PostgresPlatformStateStoreOptions): PlatformStateStore {
  const context: PostgresContext = {
    pool: options.pool,
    schema: pg.escapeIdentifier(options.schema ?? DEFAULT_PLATFORM_STATE_SCHEMA),
    retry: { ...DEFAULT_RETRY_POLICY, ...options.retry },
    logger: options.logger ?? CONSOLE_LOGGER,
  };
  const watchTiming: PostgresWatchTiming = { ...DEFAULT_WATCH_TIMING, ...options.watchTiming };
  const notifications = new ChangeNotifications(context, { ...DEFAULT_NOTIFICATION_TIMING, ...options.notificationTiming });
  const subscriptions = new Set<WatchSubscription>();

  return {
    ...createPostgresRepositories(new DirectPostgresSession(context, runPostgresTransaction)),

    transaction(transactionOptions, body) {
      return runPostgresTransaction(context, transactionOptions, (session) => body(transactionHandle(session)));
    },

    watch(request, listener) {
      const source = postgresWatchSource(request);
      const subscription: WatchSubscription = watchPostgres(source, listener, {
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
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure !== undefined) throw failure.reason;
    },
  };
}
