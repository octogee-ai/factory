import type { OpaqueMap, Page, PageRequest, RecordPatch, Revision, Stored } from "./store.js";
export type CustomerDeletionJobStatus = "suspension_pending" | "suspending" | "hibernating" | "product_verification_pending" | "verified_pending_completion" | "verified";
export interface CustomerDeletionJob {
    readonly deletionId: string;
    readonly version: 1;
    readonly uid: string;
    readonly slug: string | null;
    readonly status: CustomerDeletionJobStatus;
    readonly requestedBy: string;
    readonly requestedAt: number;
    readonly eraseAfter: number;
    readonly currentGatewayId: string | null;
    readonly erasureOperationId: string;
    readonly suspensionOperationId: string;
    readonly cleanupContext?: OpaqueMap;
    readonly postgresAgentStoreTargets?: OpaqueMap;
    readonly sharedAgentStoreCleanup?: OpaqueMap;
    readonly retiredGatewayProofs?: Readonly<Record<string, OpaqueMap>>;
    readonly archiveId?: string;
    readonly productContext?: OpaqueMap;
    readonly suspendedAt?: number;
    readonly cloudErasedAt?: number;
    readonly verifiedAt?: number;
    readonly completedAt?: number;
    readonly updatedAt?: number;
}
export type CustomerDeletionJobPatch = RecordPatch<Omit<CustomerDeletionJob, "retiredGatewayProofs">, "deletionId" | "version" | "uid" | "requestedBy" | "requestedAt">;
export interface CustomerDeletionJobFence {
    readonly revision?: Revision;
    readonly status?: readonly CustomerDeletionJobStatus[];
}
export interface CustomerDeletionJobsRepository {
    get(deletionId: string): Promise<Stored<CustomerDeletionJob> | null>;
    listForUid(uid: string): Promise<readonly Stored<CustomerDeletionJob>[]>;
    create(job: CustomerDeletionJob): Promise<void>;
    patch(deletionId: string, patch: CustomerDeletionJobPatch, fence?: CustomerDeletionJobFence): Promise<void>;
    recordRetiredGatewayProof(deletionId: string, gatewayId: string, proof: OpaqueMap): Promise<void>;
}
export interface AnonymousOperationalArchive {
    readonly id: string;
    readonly archivedAt: number;
    readonly record: OpaqueMap;
}
export interface AnonymousOperationalArchivesRepository {
    create(archive: Omit<AnonymousOperationalArchive, "id">): Promise<string>;
    merge(archiveId: string, record: OpaqueMap): Promise<void>;
    list(page: PageRequest): Promise<Page<AnonymousOperationalArchive>>;
}
export type AgentImportKind = "import" | "export";
export interface AgentImportRecord {
    readonly uid: string;
    readonly importId: string;
    readonly kind: AgentImportKind;
    readonly slug: string | null;
    readonly status: string;
    readonly importCommit: string | null;
    readonly cleanupAt: number | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly record: OpaqueMap;
}
export type AgentImportPointerName = "latest" | "export-latest";
export interface AgentImportsRepository {
    get(uid: string, importId: string): Promise<Stored<AgentImportRecord> | null>;
    listExpired(now: number, limit: number): Promise<readonly Stored<AgentImportRecord>[]>;
    listForUid(uid: string): Promise<readonly Stored<AgentImportRecord>[]>;
    put(record: AgentImportRecord): Promise<void>;
    delete(uid: string, importId: string): Promise<void>;
    getPointer(uid: string, pointer: AgentImportPointerName): Promise<Stored<{
        readonly importId: string;
        readonly updatedAt: number;
    }> | null>;
    putPointer(uid: string, pointer: AgentImportPointerName, importId: string, updatedAt: number): Promise<void>;
    deletePointer(uid: string, pointer: AgentImportPointerName): Promise<void>;
}
export interface JobRepositories {
    readonly deletions: CustomerDeletionJobsRepository;
    readonly archives: AnonymousOperationalArchivesRepository;
    readonly agentImports: AgentImportsRepository;
}
