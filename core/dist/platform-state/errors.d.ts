export type PlatformAggregate = "operation" | "operation-audit" | "gateway-recovery-receipt" | "gateway" | "gateway-release" | "gateway-assignment" | "gateway-vm-runtime" | "fleet-registry" | "shared-pool-scaler" | "platform-release" | "migration-transfer-task" | "orchestrator-config" | "platform-config" | "writer-quiescence" | "mattermost-admin" | "builder" | "builder-agent" | "placement-receipt" | "schedule-transfer" | "agent-store" | "workspace" | "workspace-member" | "workspace-project" | "workspace-channel" | "builder-agent-identity" | "builder-secret" | "gateway-ticket" | "control-ticket" | "control-session" | "gateway-access-audit" | "model-broker-token" | "model-broker-gateway-token" | "customer-deletion-job" | "anonymous-operational-archive" | "agent-import" | "agent-import-pointer";
export type PlatformStateBackend = "firestore" | "postgresql";
export type FenceName = "revision" | "status" | "startedAt" | "updatedAt" | "epoch" | "generation" | "leaseId" | "retirementVersion" | "latestRelease" | "runtimeRestartFence" | "actionClaimId" | "actionSequence" | "attemptId" | "absent" | "present";
export interface RecordKey {
    readonly aggregate: PlatformAggregate;
    readonly key: string;
}
export interface FenceMismatchError extends Error {
    readonly code: "fence-mismatch";
    readonly record: RecordKey;
    readonly fence: FenceName;
    readonly expected: unknown;
    readonly actual: unknown;
}
export interface MissingRecordError extends Error {
    readonly code: "missing-record";
    readonly record: RecordKey;
}
export interface AlreadyExistsError extends Error {
    readonly code: "already-exists";
    readonly record: RecordKey;
}
export type UnsupportedOperationReason = "read-after-write" | "write-in-read-only-transaction" | "backend-capability";
export interface DuplicateRecordError extends Error {
    readonly code: "duplicate-record";
    readonly aggregate: PlatformAggregate;
    readonly lookup: string;
    readonly value: string;
    readonly keysFound: readonly string[];
}
export interface UnsupportedOperationError extends Error {
    readonly code: "unsupported-operation";
    readonly backend: PlatformStateBackend;
    readonly operation: string;
    readonly reason: UnsupportedOperationReason;
}
export interface ContentionExhaustedError extends Error {
    readonly code: "contention-exhausted";
    readonly backend: PlatformStateBackend;
    readonly transactionLabel: string;
    readonly attempts: number;
}
export type PlatformStateError = FenceMismatchError | MissingRecordError | AlreadyExistsError | DuplicateRecordError | UnsupportedOperationError | ContentionExhaustedError;
