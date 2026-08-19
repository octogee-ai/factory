

import type {
  FleetBrokerProjectCheckoutScope,
  FleetBrokerUserSnapshot,
} from "./fleet-broker.js";

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

export const CONFIG_PATCH_DEADLINE_MS = 120_000;

export const ADD_CUSTOMER_DEADLINE_MS = 300_000;

export const MIGRATION_QUIESCE_TIMEOUT_MS = 60_000;
export const MIGRATION_TRANSFER_TIMEOUT_MS = ADD_CUSTOMER_DEADLINE_MS + 30_000;
export const MIGRATION_UNMOUNT_TIMEOUT_MS = 2 * CONFIG_PATCH_DEADLINE_MS + 30_000;
export const MIGRATION_VERIFY_TIMEOUT_MS = VERIFY_ACCOUNT_TIMEOUT_MS + 30_000;

// Window the import-handler's migrating-in pin guards a freshly-imported customer from the
// reconcile evict direction. Must outlast import→cutover so a slow import never false-evicts;
// also bounds how long a failed-migration orphan lingers before lazy eviction. See
// local-coach-wired.ts (the pin) and fleet-provisioner getEvictObservedSlugs (the skip).
export const MIGRATING_IN_PIN_TTL_MS = MIGRATION_TRANSFER_TIMEOUT_MS + 60_000;

export const SIGNATURE_HEADER = "X-Fleet-Controller-Signature";

// Unauthenticated probe body. Reachable by the kubelet (which cannot sign) and by
// every pod the fleet ingress policy admits on the controller port, so it carries
// no tenant identity: no roster, no gatewayId, no image versions. podUid is the
// pod's own K8s UID — what a sibling needs to tell itself apart from a live
// revision of the same gateway (see surge-reconcile-gate observeReadySibling).
export interface FleetHealthResponse {
  status: string;
  podUid: string | null;
  startedAt: number;
}

// Tenant-bearing fleet state. Signed with the fleet controller key, which only
// Cowboy holds — gateway pods carry the public half, so a Builder with a shell in
// their own pod cannot mint one. gatewayId is signed into the body so a captured
// signature cannot be replayed against a different pod.
export interface FleetStateRequestBody {
  requestId: string;
  gatewayId: string;
}

export interface FleetStateResponse {
  status: string;
  gatewayId: string;
  podUid: string | null;
  version: string;
  openclawVersion: string;
  startedAt: number;
  customers: string[];
  migratingIn: string[];
}

export const FLEET_STATE_PATH = "/fleet-state";

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
  openclawVersion: string;
  openclawForkSha: string;
  instanceId: string;
  observedAt: string;
}

export interface GatewayConfigStatus {
  observedAt?: unknown;
  runtimeReady?: boolean;
  openclawVersion?: string;
  openclawForkSha?: string;
  dashboardControlState?: "ready" | "missing" | "stale" | "invalid";
  dashboardControlProtocol?: OpenClawDashboardBridgeProtocol;
  dashboardControlObservedAt?: string;
}

export const GATEWAYS_COLLECTION = "gateways";

export interface MigrationRequestBody {

migrationId: string;
  
  slug: string;
}

export interface CompleteSurgeHandoffRequestBody {
  migrationId: string;
  targetPodUid: string;
}

export interface PushStateRequestBody extends MigrationRequestBody {
  targetGatewayId: string;
  targetUrl: string;
  targetImportSignature: string;
  includeActivationManifest?: boolean;
  projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
  mode?: "keys" | "pre" | "final";
}

export type MigrationTransferMode = "keys" | "pre" | "final";
export type MigrationLoadStrategy = "standard" | "expedited";
export type MigrationConfigTransferMode =
  | "activation-manifest"
  | "configured-builder-system-config";

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

export type RsyncMigrationRpcPhase =
  | "prepare-rsync-import"
  | "push-rsync-state"
  | "finish-rsync-import"
  | "abort-rsync-import";

export interface PrepareRsyncImportRequestBody extends MigrationRequestBody {
  rpcPhase: "prepare-rsync-import";
  mode: MigrationTransferMode;
  configTransferMode?: MigrationConfigTransferMode;
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
  rpcPhase: "push-rsync-state";
  mode: MigrationTransferMode;
  configTransferMode?: MigrationConfigTransferMode;
  targetHost: string;
  targetPort: number;
  transferUser: string;
  transferKey: string;
  includeActivationManifest?: boolean;
}

export interface FinishRsyncImportRequestBody extends MigrationRequestBody {
  rpcPhase: "finish-rsync-import";
  mode: MigrationTransferMode;
  configTransferMode?: MigrationConfigTransferMode;
  loadStrategy?: MigrationLoadStrategy;
}

export interface AbortRsyncImportRequestBody extends MigrationRequestBody {
  rpcPhase: "abort-rsync-import";
  mode: MigrationTransferMode;
  configTransferMode?: MigrationConfigTransferMode;
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

export interface FlushGatewayRequestBody extends MigrationRequestBody {
  reason?: string;
  expectedSystemConfigCommit?: string;
}

export interface FlushGatewayResponse {
  migrationId: string;
  slug: string;
  ok: boolean;
  durationMs: number;
  systemConfigCommit?: string;
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
  configTransferMode?: MigrationConfigTransferMode;
}

export type VerifyMigrationResponse = {
  migrationId: string;
  slug: string;
  ready: boolean;
  configTransferMode?: "activation-manifest";
  checks: {
    customerDir: boolean;
    coachWired: boolean;
    mountMarked: boolean;
    accountHealthy: boolean;
  };
} | {
  migrationId: string;
  slug: string;
  ready: boolean;
  configTransferMode: "configured-builder-system-config";
  checks: {
    customerDir: boolean;
    configuredBuilderOverlay: boolean;
    mountMarked: boolean;
    workspaceGit: boolean;
    gitRemote: boolean;
  };
};

export const MIGRATION_ID_HEADER = "X-Migration-Id";
export const MIGRATION_SLUG_HEADER = "X-Migration-Slug";
export const MIGRATION_MODE_HEADER = "X-Migration-Mode";
