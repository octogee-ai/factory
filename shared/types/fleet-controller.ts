

import type { FleetBrokerUserSnapshot } from "./fleet-broker.js";
import type { GatewayClass } from "./glm.js";

export type SystemConfigMigrationMode =
  | "none"
  | "checkpoint-only"
  | "checkpoint-and-restore";

export function systemConfigMigrationMode(
  sourceClass: GatewayClass,
  targetClass: GatewayClass,
): SystemConfigMigrationMode {
  if (sourceClass === "shared") return "none";
  return targetClass === "shared" ? "checkpoint-only" : "checkpoint-and-restore";
}

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
export const DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION = 2 as const;

export interface DurableOpenClawConfigControlProtocol {
  protocol: typeof DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL;
  version: typeof DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION;
}

export const SYSTEM_CONFIG_CONTROL_CAPABILITY_FILE =
  "system_config.control-capability.json" as const;
export const SYSTEM_CONFIG_CONTROL_CAPABILITY_TTL_MS = 15_000;

export interface SystemConfigControlCapability extends DurableOpenClawConfigControlProtocol {
  revisionId: string;
  instanceId: string;
  observedAt: string;
}

export const OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL = "openclaw-dashboard-bridge" as const;
export const OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE =
  "dashboard_bridge.capability.json" as const;
export const OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS = 15_000;

export interface OpenClawDashboardBridgeProtocol {
  protocol: typeof OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL;
  version: typeof OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION;
}

export interface OpenClawDashboardBridgeCapability extends OpenClawDashboardBridgeProtocol {
  revisionId: string;
  instanceId: string;
  observedAt: string;
}

export type SystemConfigBootRole = "normal" | "source-frozen" | "target-candidate";

export interface GatewayConfigControlOwner {
  migrationId: string;
  sourceRevisionId: string;
  targetRevisionId: string;
}

export interface GatewayConfigStatus {
  controlProtocol: DurableOpenClawConfigControlProtocol;
  observedAt?: unknown;
  freezeState?: "unfrozen" | "freezing" | "frozen";
  bootRole?: SystemConfigBootRole;
  controlOwner?: GatewayConfigControlOwner;
  checkpointCommit?: string;
  configHash?: string;
  candidateCommit?: string;
  candidateHash?: string;
  openclawVersion?: string;
  openclawForkSha?: string;
  dashboardControlState?: "ready" | "missing" | "stale" | "invalid";
  dashboardControlProtocol?: OpenClawDashboardBridgeProtocol;
  dashboardControlObservedAt?: string;
}

export function hasDurableOpenClawConfigControlProtocol(
  value: unknown,
): value is GatewayConfigStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const controlProtocol = (value as { controlProtocol?: unknown }).controlProtocol;
  if (!controlProtocol || typeof controlProtocol !== "object" || Array.isArray(controlProtocol)) {
    return false;
  }
  const marker = controlProtocol as { protocol?: unknown; version?: unknown };
  return marker.protocol === DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL &&
    marker.version === DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION;
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

export const CONFIG_CONTROL_ACTIONS = [
  "freeze-v2",
  "candidate-proof",
  "promote-candidate",
  "abort-v2",
  "finalize-v2",
] as const;

export type ConfigControlAction = typeof CONFIG_CONTROL_ACTIONS[number];

export interface ConfigControlRequestBody extends MigrationRequestBody {
  action: ConfigControlAction;
  sourceRevisionId: string;
  targetRevisionId: string;
  issuedAt: number;
  expiresAt: number;
  requestId: string;
}

export interface ConfigControlResponseBody extends MigrationRequestBody {
  sourceRevisionId: string;
  targetRevisionId: string;
}

export const CONFIG_CONTROL_CONFLICT_ERROR = "config control conflict";
export const CONFIG_CONTROL_UNAVAILABLE_ERROR = "config control unavailable";
export const CONFIG_CONTROL_OWNER_CONFLICT_CODE = "freeze-owner-conflict";
export const CONFIG_CONTROL_SCOPE_CONFLICT_CODE = "freeze-scope-conflict";
export const CONFIG_CONTROL_REF_CONFLICT_CODE = "config-ref-conflict";
export const CONFIG_CONTROL_REVISION_MISMATCH_CODE = "revision-mismatch";
export const CONFIG_CONTROL_WRITER_LOCK_BUSY_CODE = "config-writer-lock-busy";
export const CONFIG_CONTROL_GIT_UNAVAILABLE_CODE = "config-git-unavailable";

export type ConfigControlConflictCode =
  | typeof CONFIG_CONTROL_OWNER_CONFLICT_CODE
  | typeof CONFIG_CONTROL_SCOPE_CONFLICT_CODE
  | typeof CONFIG_CONTROL_REF_CONFLICT_CODE
  | typeof CONFIG_CONTROL_REVISION_MISMATCH_CODE;

export type ConfigControlUnavailableCode =
  | typeof CONFIG_CONTROL_WRITER_LOCK_BUSY_CODE
  | typeof CONFIG_CONTROL_GIT_UNAVAILABLE_CODE;

export interface ConfigControlConflictResponse {
  error: typeof CONFIG_CONTROL_CONFLICT_ERROR;
  code: ConfigControlConflictCode;
  owner?: ConfigControlOwner;
}

export interface ConfigControlUnavailableResponse {
  error: typeof CONFIG_CONTROL_UNAVAILABLE_ERROR;
  code: ConfigControlUnavailableCode;
  retryable: true;
}

export interface ConfigControlOwner {
  migrationId: string;
  slug: string;
}

export interface ConfigFreezeV2RequestBody extends ConfigControlRequestBody {
  action: "freeze-v2";
}

export interface ConfigFreezeV2Response extends ConfigControlResponseBody {
  frozen: true;
  checkpointCommit: string;
  configHash: string;
  freezeRef: string;
  freezeObject: string;
}

export interface ConfigCandidateProofRequestBody extends ConfigControlRequestBody {
  action: "candidate-proof";
  checkpointCommit: string;
  freezeObject: string;
}

export interface ConfigCandidateProofResponse extends ConfigControlResponseBody {
  checkpointCommit: string;
  candidateCommit: string;
  candidateHash: string;
  candidateRef: string;
  freezeObject: string;
  runtimeConfigHash: string;
  observedRevisionId: string;
  targetStartedAt: number;
  imageTag: string;
  buildSha: string;
  openclawVersion: string;
  configReady: true;
  provenAt: number;
}

export interface ConfigPromoteCandidateRequestBody extends ConfigControlRequestBody {
  action: "promote-candidate";
  checkpointCommit: string;
  candidateCommit: string;
  candidateHash: string;
  freezeObject: string;
}

export interface ConfigPromoteCandidateResponse extends ConfigControlResponseBody {
  promoted: true;
  promotedCommit: string;
}

export interface ConfigAbortV2RequestBody extends ConfigControlRequestBody {
  action: "abort-v2";
  checkpointCommit: string;
  candidateCommit: string | null;
  freezeObject: string;
}

export interface ConfigAbortV2Response extends ConfigControlResponseBody {
  aborted: true;
}

export interface ConfigFinalizeV2RequestBody extends ConfigControlRequestBody {
  action: "finalize-v2";
  checkpointCommit: string;
  candidateCommit: string;
  candidateHash: string;
  freezeObject: string;
}

export interface ConfigFinalizeV2Response extends ConfigControlResponseBody {
  finalized: true;
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
