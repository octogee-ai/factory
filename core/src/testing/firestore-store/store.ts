import type { Firestore } from "firebase-admin/firestore";
import type { PlatformStateStore, PlatformStateTransaction, WatchSubscription } from "../../platform-state/store.js";
import { sweepExpiredFirestoreState } from "./expiry.js";
import { createFirestoreRepositories } from "./repositories.js";
import { DirectFirestoreSession } from "./session.js";
import { runFirestoreTransaction, TransactionFirestoreSession } from "./transaction.js";
import { watchFirestore, type FirestoreWatchTiming } from "./watch.js";
import { firestoreWatchSource } from "./watch-sources.js";

export interface FirestorePlatformStateStoreOptions {
  readonly db: Firestore;
  readonly watchTiming?: FirestoreWatchTiming;
}

function transactionHandle(session: TransactionFirestoreSession): PlatformStateTransaction {
  return {
    ...createFirestoreRepositories(session),
    label: session.attempt.label,
    readOnly: session.attempt.readOnly,
    attempt: session.attempt.attempt,
  };
}

export function createFirestorePlatformStateStore(options: FirestorePlatformStateStoreOptions): PlatformStateStore {
  const { db } = options;
  const subscriptions = new Set<WatchSubscription>();
  const store: PlatformStateStore = {
    ...createFirestoreRepositories(new DirectFirestoreSession(db)),

    transaction(transactionOptions, body) {
      return runFirestoreTransaction(db, transactionOptions, (session) => body(transactionHandle(session)));
    },

    watch(request, listener) {
      const source = firestoreWatchSource(db, request);
      const subscription: WatchSubscription = watchFirestore(source, listener, {
        timing: options.watchTiming,
        onSettled: () => subscriptions.delete(subscription),
      });
      subscriptions.add(subscription);
      return subscription;
    },

    sweepExpired(now, limit) {
      return sweepExpiredFirestoreState(db, now, limit);
    },

    async close() {
      await Promise.all([...subscriptions].map((subscription) => subscription.close()));
    },
  };
  return store;
}
