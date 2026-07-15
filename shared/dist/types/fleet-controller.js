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
export const DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL = "durable-openclaw-config";
export const DURABLE_OPENCLAW_CONFIG_CONTROL_PROTOCOL_VERSION = 1;
export const OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL = "openclaw-dashboard-bridge";
export const OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION = 1;
export const OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE = "dashboard_bridge.capability.json";
export const OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS = 15_000;
export const GATEWAYS_COLLECTION = "gateways";
export const MIGRATION_RSYNC_PORT_DEFAULT = 30873;
export const CONFIG_FREEZE_CONFLICT_ERROR = "config freeze conflict";
export const CONFIG_FREEZE_UNAVAILABLE_ERROR = "config freeze unavailable";
export const CONFIG_FREEZE_OWNER_CONFLICT_CODE = "freeze-owner-conflict";
export const CONFIG_FREEZE_SCOPE_CONFLICT_CODE = "freeze-scope-conflict";
export const CONFIG_FREEZE_WRITER_LOCK_BUSY_CODE = "writer-lock-busy";
export const CONFIG_FREEZE_CHECKPOINT_PUSH_PENDING_CODE = "checkpoint-push-pending";
export const MIGRATION_ID_HEADER = "X-Migration-Id";
export const MIGRATION_SLUG_HEADER = "X-Migration-Slug";
export const MIGRATION_MODE_HEADER = "X-Migration-Mode";
