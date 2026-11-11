import type { AgentImportPointer, AgentImportPointerName, AgentImportRecord, AnonymousOperationalArchive, UserDeletionJobStatus, JobRepositories } from "../jobs.js";
import type { OpaqueMap, Revision } from "../store.js";
import type { FirestoreSession } from "./session.js";
type PlainObject = Record<string, unknown>;
export declare function storedDeletionStatus(status: UserDeletionJobStatus): string;
export declare function anonymousArchiveFromData(id: string, data: Record<string, unknown>): AnonymousOperationalArchive;
export declare function agentImportRecordFromPayload(uid: string, importId: string, payload: OpaqueMap, cleanupAt: number | null): AgentImportRecord;
export declare function agentImportRecordFromData(uid: string, importId: string, data: PlainObject): AgentImportRecord;
export declare function agentImportDocument(record: AgentImportRecord & {
    readonly revision?: Revision;
}): PlainObject;
export declare function agentImportPointerFromData(uid: string, pointer: AgentImportPointerName, data: PlainObject): AgentImportPointer;
export declare function agentImportPointerDocument(uid: string, value: AgentImportPointer): PlainObject;
export declare function createFirestoreJobRepositories(session: FirestoreSession): JobRepositories;
export {};
