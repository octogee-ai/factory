import type { AnonymousOperationalArchive, CustomerDeletionJobStatus, JobRepositories } from "../jobs.js";
import type { FirestoreSession } from "./session.js";
export declare function storedDeletionStatus(status: CustomerDeletionJobStatus): string;
export declare function anonymousArchiveFromData(id: string, data: Record<string, unknown>): AnonymousOperationalArchive;
export declare function createFirestoreJobRepositories(session: FirestoreSession): JobRepositories;
