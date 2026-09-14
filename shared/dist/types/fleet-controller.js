export const GATEWAY_HEARTBEAT_INTERVAL_MS = 15_000;
export const GATEWAY_UNREACHABLE_AFTER_MS = 3 * 60_000;
export const VERIFY_ACCOUNT_TIMEOUT_MS = 120_000;
export const CONFIG_PATCH_DEADLINE_MS = 120_000;
// A committed config patch makes OpenClaw reload: it re-registers the whole plugin
// surface and restarts channels before it answers a socket again, and every RPC opens
// a fresh one. A call that follows a patch is therefore budgeted in reload terms, not
// in request terms.
export const CONFIG_RELOAD_DEADLINE_MS = 120_000;
// A surge import's activation patch can make the target gateway restart instead of
// hot-reloading; the gateway then answers "gateway starting" for the whole boot and
// changes its config hash as its own reconcile catches up. The import waits through
// one full restart plus a reload on top of the ordinary patch budget.
export const IMPORT_ACTIVATION_PATCH_DEADLINE_MS = CONFIG_PATCH_DEADLINE_MS + 2 * CONFIG_RELOAD_DEADLINE_MS;
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
export const FLEET_STATE_PATH = "/fleet-state";
export const OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL = "openclaw-dashboard-bridge";
export const OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION = 1;
export const OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE = "dashboard_bridge.capability.json";
export const OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_TTL_MS = 15_000;
export const GATEWAYS_COLLECTION = "gateways";
export const MIGRATION_RSYNC_PORT_DEFAULT = 30873;
export const MIGRATION_ID_HEADER = "X-Migration-Id";
export const MIGRATION_SLUG_HEADER = "X-Migration-Slug";
export const MIGRATION_MODE_HEADER = "X-Migration-Mode";
