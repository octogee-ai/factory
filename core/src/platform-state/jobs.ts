import type { ClearField, OpaqueMap, Page, PageRequest, RecordPatch, Revision, Stored } from "./store.js";

export type UserDeletionJobStatus =
  | "suspension_pending"
  | "suspending"
  | "hibernating"
  | "product_verification_pending"
  | "verified_pending_completion"
  | "verified";

export interface UserDeletionJob {
  readonly deletionId: string;
  readonly version: 1;
  readonly uid?: string;
  readonly slug?: string | null;
  readonly status: UserDeletionJobStatus;
  readonly requestedBy?: string;
  readonly requestedAt: number;
  readonly eraseAfter: number;
  readonly currentGatewayId?: string | null;
  readonly erasureOperationId?: string;
  readonly suspensionOperationId?: string;
  readonly cleanupContext?: OpaqueMap;
  readonly postgresAgentStoreTargets?: readonly OpaqueMap[];
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

export type UserDeletionJobPatch = RecordPatch<
  Omit<UserDeletionJob, "retiredGatewayProofs">,
  "deletionId" | "version" | "requestedAt"
> & {
  readonly retiredGatewayProofs?: ClearField;
};

export interface UserDeletionJobFence {
  readonly revision?: Revision;
  readonly status?: readonly UserDeletionJobStatus[];
}

export interface UserDeletionJobsRepository {
  get(deletionId: string): Promise<Stored<UserDeletionJob> | null>;
  listForUid(uid: string): Promise<readonly Stored<UserDeletionJob>[]>;
  create(job: UserDeletionJob): Promise<void>;
  patch(deletionId: string, patch: UserDeletionJobPatch, fence?: UserDeletionJobFence): Promise<void>;
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

export interface AgentImportPointer {
  readonly importId: string;
  readonly slug: string | null;
  readonly updatedAt: number | null;
}

export interface AgentImportsRepository {
  get(uid: string, importId: string): Promise<Stored<AgentImportRecord> | null>;
  listExpired(now: number, limit: number): Promise<readonly Stored<AgentImportRecord>[]>;
  listForUid(uid: string): Promise<readonly Stored<AgentImportRecord>[]>;
  put(record: AgentImportRecord): Promise<void>;
  delete(uid: string, importId: string): Promise<void>;
  getPointer(uid: string, pointer: AgentImportPointerName): Promise<Stored<AgentImportPointer> | null>;
  putPointer(uid: string, pointer: AgentImportPointerName, value: AgentImportPointer): Promise<void>;
  deletePointer(uid: string, pointer: AgentImportPointerName): Promise<void>;
}

export interface JobRepositories {
  readonly deletions: UserDeletionJobsRepository;
  readonly archives: AnonymousOperationalArchivesRepository;
  readonly agentImports: AgentImportsRepository;
}
