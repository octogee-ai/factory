

import type { FleetBrokerUserSnapshot } from "./fleet-broker.js";

export type GatewayStatus = "booting" | "ready" | "draining" | "unreachable";

export interface GatewayLastError {
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

  lastError: GatewayLastError | null;

internalUrl?: string;

startedAt?: number;
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

export const VERIFY_ACCOUNT_TIMEOUT_MS = 120_000;

export const CONFIG_PATCH_DEADLINE_MS = 90_000;

export const ADD_CUSTOMER_DEADLINE_MS = 300_000;

export const MIGRATION_QUIESCE_TIMEOUT_MS = 60_000;
export const MIGRATION_TRANSFER_TIMEOUT_MS = ADD_CUSTOMER_DEADLINE_MS + 30_000;
export const MIGRATION_UNMOUNT_TIMEOUT_MS = CONFIG_PATCH_DEADLINE_MS + 30_000;
export const MIGRATION_VERIFY_TIMEOUT_MS = VERIFY_ACCOUNT_TIMEOUT_MS + 30_000;

// Window the import-handler's migrating-in pin guards a freshly-imported customer from the
// reconcile evict direction. Must outlast import→cutover so a slow import never false-evicts;
// also bounds how long a failed-migration orphan lingers before lazy eviction. See
// local-coach-wired.ts (the pin) and fleet-provisioner getEvictObservedSlugs (the skip).
export const MIGRATING_IN_PIN_TTL_MS = MIGRATION_TRANSFER_TIMEOUT_MS + 60_000;

export const SIGNATURE_HEADER = "X-Fleet-Controller-Signature";

export const DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL = "durable-openclaw-config" as const;
export const DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION = 1 as const;

export interface DurableOpenClawConfigControlProtocol {
  protocol: typeof DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL;
  version: typeof DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION;
}

export const GATEWAYS_COLLECTION = "gateways";

export interface MigrationRequestBody {

migrationId: string;
  
  slug: string;
}

export interface PushStateRequestBody extends MigrationRequestBody {
  targetGatewayId: string;
  targetUrl: string;
  targetImportSignature: string;
  includeActivationManifest?: boolean;
  mode?: "keys" | "pre" | "final";
}

export type MigrationTransferMode = "keys" | "pre" | "final";

export const MIGRATION_RSYNC_PORT_DEFAULT = 30873;

export interface PrepareImportRequestBody extends MigrationRequestBody {
  mode: MigrationTransferMode;
}

export interface ExportPathsRequestBody extends MigrationRequestBody {
  mode: MigrationTransferMode;
}

export interface ExportPathsResponse {
  migrationId: string;
  slug: string;
  sources: Array<{ cwd: string; path: string }>;
}

export interface ActivationManifestExportRequestBody extends MigrationRequestBody {}

export interface ActivationManifestExportResponse {
  migrationId: string;
  slug: string;
  manifest: Record<string, unknown> | null;
}

export interface ActivateImportRequestBody extends MigrationRequestBody {}

export interface PrepareRsyncImportRequestBody extends MigrationRequestBody {
  mode: MigrationTransferMode;
  transferUser: string;
  transferKey: string;
  sourcePodIp?: string;
}

export interface PrepareRsyncImportResponse {
  migrationId: string;
  slug: string;
  imported: boolean;
  host: string;
  port: number;
  module: string;
}

export interface PushRsyncStateRequestBody extends MigrationRequestBody {
  mode: MigrationTransferMode;
  targetHost: string;
  targetPort: number;
  transferUser: string;
  transferKey: string;
  includeActivationManifest?: boolean;
}

export interface FinishRsyncImportRequestBody extends MigrationRequestBody {
  mode: MigrationTransferMode;
}

export interface AbortRsyncImportRequestBody extends MigrationRequestBody {
  mode: MigrationTransferMode;
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

export interface ConfigControlRequestBody extends MigrationRequestBody {
  issuedAt: number;
  expiresAt: number;
  requestId: string;
}

export interface ConfigFreezeRequestBody extends ConfigControlRequestBody {}

export interface ConfigFreezeResponse extends MigrationRequestBody {
  frozen: true;
  checkpointCommit: string;
  configHash: string;
}

export interface ConfigRestoreProofRequestBody extends ConfigControlRequestBody {
  checkpointCommit: string;
}

export interface ConfigRestoreProofResponse extends MigrationRequestBody {
  restoredCommit: string;
  acceptedCommit: string;
  configHash: string;
  configReady: true;
  observedRevisionId: string;
  restoreProvenAt: number;
  configReadyAt: number;
  runtimeConfigHash: string;
}

export interface ConfigUnfreezeRequestBody extends ConfigControlRequestBody {}

export interface ConfigUnfreezeResponse extends MigrationRequestBody {
  unfrozen: boolean;
}

export interface FlushGatewayRequestBody extends MigrationRequestBody {
  reason?: string;
}

export interface FlushGatewayResponse {
  migrationId: string;
  slug: string;
  ok: boolean;
  durationMs: number;
  steps: Array<{
    name: string;
    status: "done" | "failed" | "skipped";
    error?: string;
    durationMs: number;
  }>;
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

export interface RestoreMigrationRequestBody extends MigrationRequestBody {
  uid: string;
  snapshot: FleetBrokerUserSnapshot;
}

export interface RestoreMigrationResponse {
  migrationId: string;
  slug: string;
  restored: boolean;
  steps: string[];
}

export interface VerifyMigrationRequestBody extends MigrationRequestBody {
  timeoutMs?: number;
}

export interface VerifyMigrationResponse {
  migrationId: string;
  slug: string;
  ready: boolean;
  checks: {
    customerDir: boolean;
    coachWired: boolean;
    mountMarked: boolean;
    accountHealthy: boolean;
  };
}

export const MIGRATION_ID_HEADER = "X-Migration-Id";
export const MIGRATION_SLUG_HEADER = "X-Migration-Slug";
export const MIGRATION_MODE_HEADER = "X-Migration-Mode";
