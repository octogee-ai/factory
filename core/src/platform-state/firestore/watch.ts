import {
  Timestamp,
  type DocumentChangeType,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { BackendFailureError, isPlatformStateError, type PlatformStateError } from "../errors.js";
import type {
  Stored,
  WatchAggregate,
  WatchChange,
  WatchEvent,
  WatchFilters,
  WatchListener,
  WatchRecords,
  WatchSubscription,
} from "../store.js";
import { watchCursorAt } from "./values.js";

export interface FirestoreWatchQuerySnapshot {
  readonly readTime: Timestamp;
  readonly docs: readonly QueryDocumentSnapshot[];
  docChanges(): readonly { readonly type: DocumentChangeType; readonly doc: QueryDocumentSnapshot }[];
}

export interface FirestoreWatchQuery {
  onSnapshot(onNext: (snapshot: FirestoreWatchQuerySnapshot) => void, onError: (error: Error) => void): () => void;
}

export interface FirestoreQueryWatchTarget<R> {
  readonly query: FirestoreWatchQuery;
  key(snapshot: QueryDocumentSnapshot): string;
  decode(snapshot: QueryDocumentSnapshot): Stored<R> | null;
}

export interface FirestoreDocumentWatchTarget<R> {
  readonly document: DocumentReference;
  readonly key: string;
  decode(snapshot: DocumentSnapshot): Stored<R> | null;
}

export type FirestoreWatchTarget<R> = FirestoreQueryWatchTarget<R> | FirestoreDocumentWatchTarget<R>;

export interface FirestoreWatchSource<R> {
  readonly operation: string;
  readonly targets: readonly FirestoreWatchTarget<R>[];
}

export type FirestoreWatchSourceFactory<A extends WatchAggregate> = (
  db: Firestore,
  filter: WatchFilters[A],
) => FirestoreWatchSource<WatchRecords[A]>;

export interface FirestoreWatchTiming {
  readonly initialResubscribeDelayMs: number;
  readonly maxResubscribeDelayMs: number;
}

export const DEFAULT_WATCH_TIMING: FirestoreWatchTiming = {
  initialResubscribeDelayMs: 250,
  maxResubscribeDelayMs: 30_000,
};

interface TargetState<R> {
  initialized: boolean;
  readTime: Timestamp | null;
  records: Map<string, Stored<R>>;
}

function isDocumentTarget<R>(target: FirestoreWatchTarget<R>): target is FirestoreDocumentWatchTarget<R> {
  return "document" in target;
}

class FirestoreWatch<A extends WatchAggregate> implements WatchSubscription {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private rejectClosed!: (error: unknown) => void;
  private isClosed = false;
  private generation = 0;
  private states: TargetState<WatchRecords[A]>[] = [];
  private unsubscribes: (() => void)[] = [];
  private snapshotDelivered = false;
  private delivery: Promise<void> = Promise.resolve();
  private resubscribeTimer: NodeJS.Timeout | null = null;
  private resubscribeDelayMs: number;

  constructor(
    private readonly source: FirestoreWatchSource<WatchRecords[A]>,
    private readonly listener: WatchListener<A>,
    private readonly timing: FirestoreWatchTiming,
    private readonly onSettled: () => void,
  ) {
    this.resubscribeDelayMs = timing.initialResubscribeDelayMs;
    this.closed = new Promise<void>((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
    this.subscribe();
  }

  close(): Promise<void> {
    if (!this.isClosed) {
      this.stop();
      this.resolveClosed();
    }
    return this.closed;
  }

  private stop(): void {
    this.isClosed = true;
    this.generation += 1;
    this.detach();
    if (this.resubscribeTimer !== null) clearTimeout(this.resubscribeTimer);
    this.resubscribeTimer = null;
    this.onSettled();
  }

  private fail(error: unknown): void {
    if (this.isClosed) return;
    this.stop();
    this.rejectClosed(error);
  }

  private detach(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
  }

  private enqueue(deliver: () => void | Promise<void>): void {
    this.delivery = this.delivery
      .then(async () => {
        if (!this.isClosed) await deliver();
      })
      .catch((error: unknown) => this.fail(error));
  }

  private emit(event: WatchEvent<A>): void {
    this.enqueue(() => this.listener.onEvent(event));
  }

  private report(error: PlatformStateError): void {
    this.enqueue(() => this.listener.onError(error));
  }

  private subscribe(): void {
    const generation = ++this.generation;
    this.snapshotDelivered = false;
    this.states = this.source.targets.map(() => ({ initialized: false, readTime: null, records: new Map() }));
    if (this.source.targets.length === 0) {
      this.deliverSnapshotWhenReady();
      return;
    }
    this.unsubscribes = this.source.targets.map((target, index) => {
      const onError = (error: Error) => this.onListenerError(generation, error);
      if (isDocumentTarget(target)) {
        return target.document.onSnapshot((snapshot) => this.guard(generation, () => this.onDocument(target, index, snapshot)), onError);
      }
      return target.query.onSnapshot((snapshot) => this.guard(generation, () => this.onQuery(target, index, snapshot)), onError);
    });
  }

  private guard(generation: number, handle: () => void): void {
    if (generation !== this.generation || this.isClosed) return;
    try {
      handle();
    } catch (error) {
      this.fail(error);
    }
  }

  private decode<S>(decode: (snapshot: S) => Stored<WatchRecords[A]> | null, snapshot: S): Stored<WatchRecords[A]> | null {
    try {
      return decode(snapshot);
    } catch (error) {
      if (!isPlatformStateError(error)) throw error;
      this.report(error);
      return null;
    }
  }

  private decodeAll(
    target: FirestoreQueryWatchTarget<WatchRecords[A]>,
    snapshot: FirestoreWatchQuerySnapshot,
  ): Map<string, Stored<WatchRecords[A]>> {
    const records = new Map<string, Stored<WatchRecords[A]>>();
    for (const doc of snapshot.docs) {
      const record = this.decode((s: QueryDocumentSnapshot) => target.decode(s), doc);
      if (record !== null) records.set(target.key(doc), record);
    }
    return records;
  }

  private onQuery(target: FirestoreQueryWatchTarget<WatchRecords[A]>, index: number, snapshot: FirestoreWatchQuerySnapshot): void {
    const state = this.states[index];
    state.readTime = snapshot.readTime;
    if (!this.snapshotDelivered) {
      state.initialized = true;
      state.records = this.decodeAll(target, snapshot);
      this.deliverSnapshotWhenReady();
      return;
    }
    const changes: WatchChange<A>[] = [];
    for (const change of snapshot.docChanges()) {
      const key = target.key(change.doc);
      const record = change.type === "removed" ? null : this.decode((s: QueryDocumentSnapshot) => target.decode(s), change.doc);
      this.apply(state, key, record, changes);
    }
    if (changes.length > 0) this.emit({ kind: "changes", changes, cursor: watchCursorAt(snapshot.readTime) });
  }

  private onDocument(target: FirestoreDocumentWatchTarget<WatchRecords[A]>, index: number, snapshot: DocumentSnapshot): void {
    const state = this.states[index];
    state.readTime = snapshot.readTime;
    const record = snapshot.exists ? this.decode((s: DocumentSnapshot) => target.decode(s), snapshot) : null;
    if (!this.snapshotDelivered) {
      state.initialized = true;
      state.records = record === null ? new Map() : new Map([[target.key, record]]);
      this.deliverSnapshotWhenReady();
      return;
    }
    const changes: WatchChange<A>[] = [];
    this.apply(state, target.key, record, changes);
    if (changes.length > 0) this.emit({ kind: "changes", changes, cursor: watchCursorAt(snapshot.readTime) });
  }

  private apply(
    state: TargetState<WatchRecords[A]>,
    key: string,
    record: Stored<WatchRecords[A]> | null,
    changes: WatchChange<A>[],
  ): void {
    const present = state.records.has(key);
    if (record === null) {
      if (!present) return;
      state.records.delete(key);
      changes.push({ type: "removed", key, record: null });
      return;
    }
    state.records.set(key, record);
    changes.push({ type: present ? "modified" : "added", key, record });
  }

  private deliverSnapshotWhenReady(): void {
    if (!this.states.every((state) => state.initialized)) return;
    this.snapshotDelivered = true;
    this.resubscribeDelayMs = this.timing.initialResubscribeDelayMs;
    const records = this.states.flatMap((state) => [...state.records.values()]);
    const readTimes = this.states.map((state) => state.readTime).filter((time): time is Timestamp => time !== null);
    const readTime = readTimes.reduce<Timestamp>((latest, time) => (time.valueOf() > latest.valueOf() ? time : latest), readTimes[0] ?? Timestamp.now());
    this.emit({ kind: "snapshot", records, cursor: watchCursorAt(readTime) });
  }

  private onListenerError(generation: number, error: Error): void {
    if (generation !== this.generation || this.isClosed) return;
    this.generation += 1;
    this.detach();
    this.report(new BackendFailureError("firestore", this.source.operation, { cause: error }));
    const delay = this.resubscribeDelayMs;
    this.resubscribeDelayMs = Math.min(delay * 2, this.timing.maxResubscribeDelayMs);
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = null;
      if (this.isClosed) return;
      this.emit({ kind: "resync", reason: "backend-restart" });
      this.subscribe();
    }, delay);
  }
}

export function watchFirestore<A extends WatchAggregate>(
  source: FirestoreWatchSource<WatchRecords[A]>,
  listener: WatchListener<A>,
  options: { readonly timing?: FirestoreWatchTiming; readonly onSettled?: () => void } = {},
): WatchSubscription {
  return new FirestoreWatch<A>(source, listener, options.timing ?? DEFAULT_WATCH_TIMING, options.onSettled ?? (() => {}));
}
