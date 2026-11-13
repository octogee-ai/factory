import { Timestamp, } from "firebase-admin/firestore";
import { BackendFailureError, isPlatformStateError } from "../../platform-state/errors.js";
import { watchCursorAt } from "./values.js";
export const DEFAULT_WATCH_TIMING = {
    initialResubscribeDelayMs: 250,
    maxResubscribeDelayMs: 30_000,
};
function isDocumentTarget(target) {
    return "document" in target;
}
class FirestoreWatch {
    source;
    listener;
    timing;
    onSettled;
    closed;
    resolveClosed;
    rejectClosed;
    isClosed = false;
    generation = 0;
    states = [];
    unsubscribes = [];
    snapshotDelivered = false;
    delivery = Promise.resolve();
    resubscribeTimer = null;
    resubscribeDelayMs;
    constructor(source, listener, timing, onSettled) {
        this.source = source;
        this.listener = listener;
        this.timing = timing;
        this.onSettled = onSettled;
        this.resubscribeDelayMs = timing.initialResubscribeDelayMs;
        this.closed = new Promise((resolve, reject) => {
            this.resolveClosed = resolve;
            this.rejectClosed = reject;
        });
        this.subscribe();
    }
    close() {
        if (!this.isClosed) {
            this.stop();
            this.resolveClosed();
        }
        return this.closed;
    }
    stop() {
        this.isClosed = true;
        this.generation += 1;
        this.detach();
        if (this.resubscribeTimer !== null)
            clearTimeout(this.resubscribeTimer);
        this.resubscribeTimer = null;
        this.onSettled();
    }
    fail(error) {
        if (this.isClosed)
            return;
        this.stop();
        this.rejectClosed(error);
    }
    detach() {
        for (const unsubscribe of this.unsubscribes)
            unsubscribe();
        this.unsubscribes = [];
    }
    enqueue(deliver) {
        this.delivery = this.delivery
            .then(async () => {
            if (!this.isClosed)
                await deliver();
        })
            .catch((error) => this.fail(error));
    }
    emit(event) {
        this.enqueue(() => this.listener.onEvent(event));
    }
    report(error) {
        this.enqueue(() => this.listener.onError(error));
    }
    subscribe() {
        const generation = ++this.generation;
        this.snapshotDelivered = false;
        this.states = this.source.targets.map(() => ({ initialized: false, readTime: null, records: new Map() }));
        if (this.source.targets.length === 0) {
            this.deliverSnapshotWhenReady();
            return;
        }
        this.unsubscribes = this.source.targets.map((target, index) => {
            const onError = (error) => this.onListenerError(generation, error);
            if (isDocumentTarget(target)) {
                return target.document.onSnapshot((snapshot) => this.guard(generation, () => this.onDocument(target, index, snapshot)), onError);
            }
            return target.query.onSnapshot((snapshot) => this.guard(generation, () => this.onQuery(target, index, snapshot)), onError);
        });
    }
    guard(generation, handle) {
        if (generation !== this.generation || this.isClosed)
            return;
        try {
            handle();
        }
        catch (error) {
            this.fail(error);
        }
    }
    decode(decode, snapshot) {
        try {
            return decode(snapshot);
        }
        catch (error) {
            if (!isPlatformStateError(error))
                throw error;
            this.report(error);
            return null;
        }
    }
    decodeAll(target, snapshot) {
        const records = new Map();
        for (const doc of snapshot.docs) {
            const record = this.decode((s) => target.decode(s), doc);
            if (record !== null)
                records.set(target.key(doc), record);
        }
        return records;
    }
    onQuery(target, index, snapshot) {
        const state = this.states[index];
        state.readTime = snapshot.readTime;
        if (!this.snapshotDelivered) {
            state.initialized = true;
            state.records = this.decodeAll(target, snapshot);
            this.deliverSnapshotWhenReady();
            return;
        }
        const changes = [];
        for (const change of snapshot.docChanges()) {
            const key = target.key(change.doc);
            const record = change.type === "removed" ? null : this.decode((s) => target.decode(s), change.doc);
            this.apply(state, key, record, changes);
        }
        if (changes.length > 0)
            this.emit({ kind: "changes", changes, cursor: watchCursorAt(snapshot.readTime) });
    }
    onDocument(target, index, snapshot) {
        const state = this.states[index];
        state.readTime = snapshot.readTime;
        const record = snapshot.exists ? this.decode((s) => target.decode(s), snapshot) : null;
        if (!this.snapshotDelivered) {
            state.initialized = true;
            state.records = record === null ? new Map() : new Map([[target.key, record]]);
            this.deliverSnapshotWhenReady();
            return;
        }
        const changes = [];
        this.apply(state, target.key, record, changes);
        if (changes.length > 0)
            this.emit({ kind: "changes", changes, cursor: watchCursorAt(snapshot.readTime) });
    }
    apply(state, key, record, changes) {
        const present = state.records.has(key);
        if (record === null) {
            if (!present)
                return;
            state.records.delete(key);
            changes.push({ type: "removed", key, record: null });
            return;
        }
        state.records.set(key, record);
        changes.push({ type: present ? "modified" : "added", key, record });
    }
    deliverSnapshotWhenReady() {
        if (!this.states.every((state) => state.initialized))
            return;
        this.snapshotDelivered = true;
        this.resubscribeDelayMs = this.timing.initialResubscribeDelayMs;
        const records = this.states.flatMap((state) => [...state.records.values()]);
        const readTimes = this.states.map((state) => state.readTime).filter((time) => time !== null);
        const readTime = readTimes.reduce((latest, time) => (time.valueOf() > latest.valueOf() ? time : latest), readTimes[0] ?? Timestamp.now());
        this.emit({ kind: "snapshot", records, cursor: watchCursorAt(readTime) });
    }
    onListenerError(generation, error) {
        if (generation !== this.generation || this.isClosed)
            return;
        this.generation += 1;
        this.detach();
        this.report(new BackendFailureError("firestore", this.source.operation, { cause: error }));
        const delay = this.resubscribeDelayMs;
        this.resubscribeDelayMs = Math.min(delay * 2, this.timing.maxResubscribeDelayMs);
        this.resubscribeTimer = setTimeout(() => {
            this.resubscribeTimer = null;
            if (this.isClosed)
                return;
            this.emit({ kind: "resync", reason: "backend-restart" });
            this.subscribe();
        }, delay);
    }
}
export function watchFirestore(source, listener, options = {}) {
    return new FirestoreWatch(source, listener, options.timing ?? DEFAULT_WATCH_TIMING, options.onSettled ?? (() => { }));
}
