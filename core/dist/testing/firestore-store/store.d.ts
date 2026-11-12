import type { Firestore } from "firebase-admin/firestore";
import type { PlatformStateStore } from "../../platform-state/store.js";
import { type FirestoreWatchTiming } from "./watch.js";
export interface FirestorePlatformStateStoreOptions {
    readonly db: Firestore;
    readonly watchTiming?: FirestoreWatchTiming;
}
export declare function createFirestorePlatformStateStore(options: FirestorePlatformStateStoreOptions): PlatformStateStore;
