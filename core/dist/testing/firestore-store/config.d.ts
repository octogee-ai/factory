import type { ConfigRepositories } from "../../platform-state/config.js";
import type { FirestoreSession } from "./session.js";
import type { FirestoreWatchSourceFactory } from "./watch.js";
export declare function createFirestoreConfigRepositories(session: FirestoreSession): ConfigRepositories;
export declare const firestoreConfigWatchSource: FirestoreWatchSourceFactory<"config">;
