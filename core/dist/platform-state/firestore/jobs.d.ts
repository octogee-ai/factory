import type { CustomerDeletionJobStatus, JobRepositories } from "../jobs.js";
import type { FirestoreSession } from "./session.js";
export declare function storedDeletionStatus(status: CustomerDeletionJobStatus): string;
export declare function createFirestoreJobRepositories(session: FirestoreSession): JobRepositories;
