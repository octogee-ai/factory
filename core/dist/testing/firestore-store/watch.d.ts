import { Timestamp, type DocumentChangeType, type DocumentReference, type DocumentSnapshot, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import type { Stored, WatchAggregate, WatchFilters, WatchListener, WatchRecords, WatchSubscription } from "../../platform-state/store.js";
export interface FirestoreWatchQuerySnapshot {
    readonly readTime: Timestamp;
    readonly docs: readonly QueryDocumentSnapshot[];
    docChanges(): readonly {
        readonly type: DocumentChangeType;
        readonly doc: QueryDocumentSnapshot;
    }[];
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
export type FirestoreWatchSourceFactory<A extends WatchAggregate> = (db: Firestore, filter: WatchFilters[A]) => FirestoreWatchSource<WatchRecords[A]>;
export interface FirestoreWatchTiming {
    readonly initialResubscribeDelayMs: number;
    readonly maxResubscribeDelayMs: number;
}
export declare const DEFAULT_WATCH_TIMING: FirestoreWatchTiming;
export declare function watchFirestore<A extends WatchAggregate>(source: FirestoreWatchSource<WatchRecords[A]>, listener: WatchListener<A>, options?: {
    readonly timing?: FirestoreWatchTiming;
    readonly onSettled?: () => void;
}): WatchSubscription;
