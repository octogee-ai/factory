import type {
  GlmOperationRecord,
  Operation,
  OperationAuditRecord,
  OperationAuditStatus,
  OperationKind,
  OperationStatus,
  OperationStep,
} from "@octogee/shared/types/glm";
import type { Clearable, ClearField, OpaqueMap, Page, PageRequest, RecordPatch, Revision, Stored } from "./store.js";

export interface OperationJournalFields {
  readonly gatewayId?: string;
  readonly inputUid?: string;
  readonly expireAt?: number;
  readonly cancellationRequestedAt?: number;
  readonly cancelledByDeletionId?: string;
  readonly retryRequestedAt?: number;
  readonly retryRequestedBy?: string;
  readonly supersededBy?: OpaqueMap;
  readonly restoreAttempt?: OpaqueMap;
  readonly restoreRuntimeRecovery?: OpaqueMap;
  readonly sourceRuntimeRecovery?: OpaqueMap;
  readonly sourceRecoverySupersededBy?: string;
  readonly sourceRecoveryRequestedAt?: number;
  readonly sourceRecoveryRequestedBy?: string;
  readonly nativeReturnSourceRecoveryReceipts?: readonly OpaqueMap[];
  readonly forceDrainRequest?: OpaqueMap;
  readonly rolloutLane?: string;
}

export type OperationRecord = Operation & OperationJournalFields;

export type NewOperation = Omit<OperationRecord, "id">;

export type OperationPatch = RecordPatch<OperationRecord, "id" | "kind" | "createdAt" | "createdBy" | "input"> & {
  readonly input?: Clearable<OperationRecord["input"]>;
  readonly createdBy?: ClearField;
};

export interface OperationFence {
  readonly revision?: Revision;
  readonly status?: readonly OperationStatus[];
  readonly startedAt?: number | null;
}

export interface OperationUidFilter {
  readonly statuses?: readonly OperationStatus[];
  readonly kind?: OperationKind;
}

export interface OperationsRepository {
  get(operationId: string): Promise<Stored<OperationRecord> | null>;
  getMany(operationIds: readonly string[]): Promise<ReadonlyMap<string, Stored<OperationRecord>>>;
  listByStatus(statuses: readonly OperationStatus[]): Promise<readonly Stored<OperationRecord>[]>;
  listUnreleasedSchedulerHandoffs(statuses: readonly OperationStatus[]): Promise<readonly Stored<OperationRecord>[]>;
  listByGateway(gatewayId: string, limit?: number): Promise<readonly Stored<OperationRecord>[]>;
  listByInputGateway(gatewayId: string): Promise<readonly Stored<OperationRecord>[]>;
  listForUid(uid: string, filter: OperationUidFilter): Promise<readonly Stored<OperationRecord>[]>;
  listByKind(kind: OperationKind, statuses?: readonly OperationStatus[]): Promise<readonly Stored<OperationRecord>[]>;
  listReferencingUid(uid: string): Promise<readonly Stored<OperationRecord>[]>;
  listByInputBuilderSlugPrefix(prefix: string): Promise<readonly Stored<OperationRecord>[]>;
  enqueue(operation: NewOperation): Promise<string>;
  create(operation: OperationRecord): Promise<void>;
  put(operation: OperationRecord): Promise<void>;
  patch(operationId: string, patch: OperationPatch, fence?: OperationFence): Promise<void>;
  delete(operationId: string): Promise<void>;
}

export type OperationAuditRow = OperationAuditRecord & { readonly expireAt?: number };

export type OperationAuditPatch = RecordPatch<
  OperationAuditRow,
  "id" | "recordType" | "schemaVersion" | "idempotencyKey" | "mutationFingerprint" | "createdAt"
>;

export interface OperationAuditFence {
  readonly revision?: Revision;
  readonly status?: readonly OperationAuditStatus[];
  readonly actionClaimId?: string | null;
  readonly actionStartedAt?: number | null;
}

export interface OperationAuditsRepository {
  get(auditId: string): Promise<Stored<OperationAuditRow> | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<Stored<OperationAuditRow> | null>;
  create(audit: OperationAuditRow): Promise<void>;
  patch(auditId: string, patch: OperationAuditPatch, fence?: OperationAuditFence): Promise<void>;
  delete(auditId: string): Promise<void>;
}

export interface GatewayRecoveryReceipt {
  readonly id: string;
  readonly kind: "recover-unreachable-disposable";
  readonly status: OperationStatus;
  readonly origin?: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly firstStartedAt?: number | null;
  readonly completedAt: number | null;
  readonly input: OpaqueMap;
  readonly steps: readonly OperationStep[];
  readonly gatewayId: string;
  readonly inputUid: string;
  readonly recoveryReceipt?: OpaqueMap;
}

export type GatewayRecoveryReceiptPatch = RecordPatch<GatewayRecoveryReceipt, "id" | "kind" | "createdAt" | "createdBy">;

export interface GatewayRecoveryReceiptsRepository {
  get(receiptId: string): Promise<Stored<GatewayRecoveryReceipt> | null>;
  listReferencingUid(uid: string): Promise<readonly Stored<GatewayRecoveryReceipt>[]>;
  create(receipt: GatewayRecoveryReceipt): Promise<void>;
  patch(receiptId: string, patch: GatewayRecoveryReceiptPatch, fence?: { readonly revision?: Revision }): Promise<void>;
  delete(receiptId: string): Promise<void>;
}

export interface JournalRepositories {
  readonly operations: OperationsRepository;
  readonly audits: OperationAuditsRepository;
  readonly recoveryReceipts: GatewayRecoveryReceiptsRepository;
  getRecord(recordId: string): Promise<Stored<GlmOperationRecord> | null>;
  listRecent(page: PageRequest): Promise<Page<Stored<GlmOperationRecord>>>;
}
