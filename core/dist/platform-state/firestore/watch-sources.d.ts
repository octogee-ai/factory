import type { Firestore } from "firebase-admin/firestore";
import type { WatchAggregate, WatchRecords, WatchRequest } from "../store.js";
import type { FirestoreWatchSource } from "./watch.js";
export declare function firestoreWatchSource<A extends WatchAggregate>(db: Firestore, request: WatchRequest<A>): FirestoreWatchSource<WatchRecords[A]>;
