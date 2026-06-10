

export type GatewayStatus = "booting" | "ready" | "draining" | "unreachable";

export interface GatewayLastError {
  jobId: string;
  slug: string;
  message: string;
  at: unknown; 
}

export interface GatewayState {
  
  gatewayId: string;
  status: GatewayStatus;

lastHeartbeatAt: unknown; 
  
  version: string;
  
  openclawVersion: string;

mountedCustomers: string[];

inFlightJobId: string | null;
  
  lastJobCompletedAt: unknown | null; 
  
  lastError: GatewayLastError | null;

internalUrl?: string;

startedAt?: number;

failedCustomers?: Record<string, { failCount: number; lastFailedAt: unknown  }>;
}

export interface CustomerSnapshot {
  uid: string;
  slug: string;
  tier: string;
  gatewayId: string;
  repoUrl: string;
  agentIds: string[];
  customerMmUserId: string | null;
  channels: Array<{
    scope: "workspace" | "project";
    projectId?: string;
    kind: string;
    channelId: string;
  }>;
}

export const GATEWAY_HEARTBEAT_INTERVAL_MS = 15_000;

export const GATEWAY_UNREACHABLE_AFTER_MS = 3 * 60_000;

export const JOB_TTL_MS = 6 * 60_000;

export const VERIFY_ACCOUNT_TIMEOUT_MS = 120_000;

export const CONFIG_PATCH_DEADLINE_MS = 90_000;

export const ADD_CUSTOMER_DEADLINE_MS = 300_000;

export const MIGRATION_QUIESCE_TIMEOUT_MS = 60_000;
export const MIGRATION_TRANSFER_TIMEOUT_MS = ADD_CUSTOMER_DEADLINE_MS + 30_000;
export const MIGRATION_UNMOUNT_TIMEOUT_MS = CONFIG_PATCH_DEADLINE_MS + 30_000;

export const SIGNATURE_HEADER = "X-Fleet-Controller-Signature";

export const GATEWAYS_COLLECTION = "gateways";
export const RESTORE_JOBS_COLLECTION = "restoreJobs";

export interface MigrationRequestBody {

migrationId: string;
  
  slug: string;
}

export interface PushStateRequestBody extends MigrationRequestBody {
  targetGatewayId: string;
  targetUrl: string;
  targetImportSignature?: string;
  includeActivationManifest?: boolean;
}

export interface QuiesceRequestBody extends MigrationRequestBody {

timeoutMs?: number;
}

export interface QuiesceResponse {
  migrationId: string;
  slug: string;

drained: boolean;

runningCount: number;
}

export interface ImportResponse {
  migrationId: string;
  slug: string;

imported: boolean;

alreadyMounted?: boolean;
}

export interface UnmountRequestBody extends MigrationRequestBody {}

export interface UnmountResponse {
  migrationId: string;
  slug: string;

unmounted: boolean;
}

export const MIGRATION_ID_HEADER = "X-Migration-Id";
export const MIGRATION_SLUG_HEADER = "X-Migration-Slug";

const BACKOFF_BASE_MS = 10_000;
const BACKOFF_CAP_MS = 120 * 60_000;

export function backoffMsForFailCount(failCount: number): number {
  if (failCount <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, failCount - 1), BACKOFF_CAP_MS);
}
