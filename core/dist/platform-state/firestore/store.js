import { sweepExpiredFirestoreState } from "./expiry.js";
import { createFirestoreRepositories } from "./repositories.js";
import { DirectFirestoreSession } from "./session.js";
import { runFirestoreTransaction } from "./transaction.js";
import { watchFirestore } from "./watch.js";
import { firestoreWatchSource } from "./watch-sources.js";
function transactionHandle(session) {
    return {
        ...createFirestoreRepositories(session),
        label: session.attempt.label,
        readOnly: session.attempt.readOnly,
        attempt: session.attempt.attempt,
    };
}
export function createFirestorePlatformStateStore(options) {
    const { db } = options;
    const subscriptions = new Set();
    return {
        ...createFirestoreRepositories(new DirectFirestoreSession(db)),
        transaction(transactionOptions, body) {
            return runFirestoreTransaction(db, transactionOptions, (session) => body(transactionHandle(session)));
        },
        watch(request, listener) {
            const source = firestoreWatchSource(db, request);
            const subscription = watchFirestore(source, listener, {
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
}
