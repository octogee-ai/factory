import type { DocumentSnapshot } from "firebase-admin/firestore";
import type { MigrationTasksRepository, MigrationTransferTask } from "../migration-tasks.js";
import type { Revision, Stored } from "../store.js";
import type { FirestoreSession } from "./session.js";
import type { FirestoreWatchSourceFactory } from "./watch.js";
export declare function migrationTransferTaskFromData(id: string, data: Readonly<Record<string, unknown>>, revision: Revision): Stored<MigrationTransferTask>;
export declare function decodeMigrationTransferTask(snapshot: DocumentSnapshot): Stored<MigrationTransferTask> | null;
export declare function createFirestoreMigrationTasksRepository(session: FirestoreSession): MigrationTasksRepository;
export declare const firestoreMigrationTasksWatchSource: FirestoreWatchSourceFactory<"migrationTasks">;
