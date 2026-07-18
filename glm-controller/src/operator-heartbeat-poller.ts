/**
 * Pull-model fleet reporting + eviction for db-less gateways.
 *
 * Gateway pods hold NO platform Firestore credentials. The pod cannot read the
 * assigned roster directly or write its own heartbeat. Instead, Cowboy (the
 * trusted fleet authority) polls each gateway's `/health` for its locally-present
 * coach-wired customers, and does the trusted-side roster work:
 *  - reporting: writes gateways/{id}.mountedCustomers = present ∩ assigned;
 *  - eviction: tears down a departed customer's LOCAL footprint (present − assigned)
 *    by calling the pod's existing /unmount RPC — a local-only teardown that needs
 *    no platform credentials. Debounced by a consecutive-streak so a transient
 *    assigned-state blip never blind-evicts.
 *
 * Identity fields (version/startedAt/internalUrl, status=ready) stay owned by the
 * reconcile path (publishPlatformGatewayReady). This poller owns the live telemetry
 * — status, the honest mounted set, lastHeartbeatAt — and a successful poll IS the
 * liveness signal (it only writes when /health responds).
*/

import {
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
  type GatewayConfigStatus,
} from "@octogee/shared/types/fleet-controller";

export const EVICT_AFTER_STREAK = 2;

export interface OperatorGatewayHealth {
  status: string;
  version?: string;
  openclawVersion?: string;
  /** The pod's current process start (epoch ms). Persisted trusted-side so the
   *  shell reaper can detect a roll. Optional — omitted by a malformed /health. */
  startedAt?: number;
  /** Slugs the pod actually has on disk + coach-wired — reported Firestore-free. */
  customers: string[];
  /** Slugs mid-migration-import (coach-wired here but cutover hasn't moved their assignment
   *  yet). Skipped as eviction candidates so a slow import→cutover isn't drained. */
  migratingIn?: string[];
  configStatus?: GatewayConfigStatus;
}

export interface OperatorHeartbeatRecord {
  status: string;
  mountedCustomers: string[];
  version?: string;
  openclawVersion?: string;
  /** Live pod-boot time (epoch ms) — lets reapGoneGatewayShells reap pre-roll shells. */
  startedAt?: number;
  configStatus?: GatewayConfigStatus;
}

export interface OperatorHeartbeatPollerDeps {
  /** Gateways Cowboy should report for (running/desired-live). */
  listGatewayIds: () => Promise<string[]>;
  /** GET the gateway's /health; null when unreachable (do not clobber the doc). */
  fetchHealth: (gatewayId: string) => Promise<OperatorGatewayHealth | null>;
  /** Slugs assigned to this gateway in Firestore (users gatewayId==id, complete). */
  readAssignedSlugs: (gatewayId: string) => Promise<string[]>;
  /** Persist live telemetry; the impl stamps lastHeartbeatAt. */
  writeHeartbeat: (gatewayId: string, record: OperatorHeartbeatRecord) => Promise<void>;
  /** Tear down a departed customer's local footprint on the gateway (pod /unmount).
   *  Omit to disable Cowboy-driven eviction (e.g. no fleet secret configured). */
  evictSlug?: (gatewayId: string, slug: string) => Promise<void>;
  /** Consecutive departed-observations before eviction (debounce). Default 2. */
  evictAfterStreak?: number;
  log: (msg: string) => void;
}

/** Per-gateway → per-slug consecutive "orphaned" (present ∧ unassigned) streak. */
export type EvictionStreaks = Map<string, Map<string, number>>;
/** `gatewayId\0slug` entries currently being torn down via /unmount. */
export type EvictionInFlight = Set<string>;

interface EvictionState {
  streaks: EvictionStreaks;
  inFlight: EvictionInFlight;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The honest mounted set: locally-present customers that are still assigned here. */
export function intersectMounted(present: string[], assigned: string[]): string[] {
  const assignedSet = new Set(assigned);
  return present
    .filter((slug) => assignedSet.has(slug))
    .sort((a, b) => a.localeCompare(b));
}

/** Locally-present customers that are no longer assigned here — eviction candidates. */
export function departedFromAssigned(present: string[], assigned: string[]): string[] {
  const assignedSet = new Set(assigned);
  return present
    .filter((slug) => !assignedSet.has(slug))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Parse + validate a gateway /health body. Returns null for anything malformed
 * (non-object, missing/empty status, non-array customers) so the poller treats a
 * garbled /health like an unreachable gateway — it never writes fabricated state.
 */
export function parseHealthResponse(json: unknown): OperatorGatewayHealth | null {
  if (typeof json !== "object" || json === null) return null;
  const body = json as {
    status?: unknown;
    customers?: unknown;
    startedAt?: unknown;
    version?: unknown;
    openclawVersion?: unknown;
    migratingIn?: unknown;
    configStatus?: unknown;
  };
  if (typeof body.status !== "string" || body.status.length === 0) return null;
  if (!Array.isArray(body.customers)) return null;
  const customers = body.customers.filter(
    (slug): slug is string => typeof slug === "string",
  );
  return {
    status: body.status,
    customers,
    ...healthStringField("version", body.version, false),
    ...healthStringField("openclawVersion", body.openclawVersion, true),
    ...(typeof body.startedAt === "number" ? { startedAt: body.startedAt } : {}),
    ...(Array.isArray(body.migratingIn)
      ? { migratingIn: body.migratingIn.filter(isString) }
      : {}),
    ...configStatusField(body.configStatus),
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function healthStringField<K extends "version" | "openclawVersion">(
  key: K,
  value: unknown,
  requireNonEmpty: boolean,
): Partial<Pick<OperatorGatewayHealth, K>> {
  if (typeof value !== "string" || (requireNonEmpty && value.length === 0)) return {};
  return { [key]: value } as Partial<Pick<OperatorGatewayHealth, K>>;
}

function configStatusField(
  value: unknown,
): Partial<Pick<OperatorGatewayHealth, "configStatus">> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const status = value as GatewayConfigStatus;
  const validVersion = status.openclawVersion === undefined ||
    typeof status.openclawVersion === "string";
  const validForkSha = status.openclawForkSha === undefined ||
    typeof status.openclawForkSha === "string";
  return validVersion && validForkSha && hasValidDashboardControlStatus(status)
    ? { configStatus: status }
    : {};
}

function hasValidDashboardControlStatus(status: GatewayConfigStatus): boolean {
  if (status.dashboardControlState === undefined) {
    return status.dashboardControlProtocol === undefined &&
      status.dashboardControlObservedAt === undefined;
  }
  if (
    status.dashboardControlState !== "ready" &&
    status.dashboardControlState !== "missing" &&
    status.dashboardControlState !== "stale" &&
    status.dashboardControlState !== "invalid"
  ) {
    return false;
  }
  if (status.dashboardControlState !== "ready") {
    return status.dashboardControlProtocol === undefined &&
      status.dashboardControlObservedAt === undefined;
  }
  const observedAt = status.dashboardControlObservedAt;
  return status.dashboardControlProtocol?.protocol === OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL &&
    status.dashboardControlProtocol.version === OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION &&
    typeof observedAt === "string" &&
    observedAt.length <= 40 &&
    Number.isFinite(Date.parse(observedAt)) &&
    new Date(observedAt).toISOString() === observedAt;
}

async function evictDepartedForGateway(
  deps: OperatorHeartbeatPollerDeps,
  gatewayId: string,
  observed: { footprint: string[]; assigned: string[]; migratingIn: string[] },
  state: EvictionState,
): Promise<void> {
  if (!deps.evictSlug) return;
  const { footprint, assigned, migratingIn } = observed;
  const threshold = deps.evictAfterStreak ?? EVICT_AFTER_STREAK;
  const assignedSet = new Set(assigned);
  const onDisk = new Set(footprint);
  const migratingSet = new Set(migratingIn);

  let gatewayStreaks = state.streaks.get(gatewayId);
  if (!gatewayStreaks) {
    gatewayStreaks = new Map();
    state.streaks.set(gatewayId, gatewayStreaks);
  }
  // A slug that is re-assigned, has dropped off disk, or is now migrating-in is no longer
  // orphaned — reset its streak.
  for (const slug of [...gatewayStreaks.keys()]) {
    if (!onDisk.has(slug) || assignedSet.has(slug) || migratingSet.has(slug)) {
      gatewayStreaks.delete(slug);
    }
  }

  for (const slug of departedFromAssigned(footprint, assigned)) {
    // A fresh migration import is coach-wired here before cutover moves its assignment —
    // not an orphan. Skip it so a slow import→cutover isn't drained mid-flight.
    if (migratingSet.has(slug)) continue;
    const streak = (gatewayStreaks.get(slug) ?? 0) + 1;
    gatewayStreaks.set(slug, streak);
    if (streak < threshold) continue;
    const flightKey = `${gatewayId}\0${slug}`;
    if (state.inFlight.has(flightKey)) {
      deps.log(
        `[operator-poll] ${gatewayId}/${slug} eviction already in flight — skipping duplicate`,
      );
      continue;
    }
    state.inFlight.add(flightKey);
    try {
      await deps.evictSlug(gatewayId, slug);
    } catch (err) {
      deps.log(
        `[operator-poll] ⚠ evict ${gatewayId}/${slug}: ${errMsg(err)} — will retry next tick`,
      );
    } finally {
      state.inFlight.delete(flightKey);
    }
  }
}

export async function pollOperatorHeartbeatsOnce(
  deps: OperatorHeartbeatPollerDeps,
  streaks: EvictionStreaks = new Map(),
  inFlight: EvictionInFlight = new Set(),
): Promise<void> {
  let gatewayIds: string[];
  try {
    gatewayIds = await deps.listGatewayIds();
  } catch (err) {
    deps.log(`[operator-poll] ⚠ failed to list gateways: ${errMsg(err)}`);
    return;
  }

  for (const gatewayId of gatewayIds) {
    try {
      const health = await deps.fetchHealth(gatewayId);
      if (!health) continue;
      const assigned = await deps.readAssignedSlugs(gatewayId);
      const record: OperatorHeartbeatRecord = {
        status: health.status,
        mountedCustomers: intersectMounted(health.customers, assigned),
      };
      if (typeof health.version === "string") record.version = health.version;
      if (typeof health.openclawVersion === "string") {
        record.openclawVersion = health.openclawVersion;
      }
      if (typeof health.startedAt === "number") record.startedAt = health.startedAt;
      if (health.configStatus) record.configStatus = health.configStatus;
      await deps.writeHeartbeat(gatewayId, record);
      await evictDepartedForGateway(
        deps,
        gatewayId,
        { footprint: health.customers, assigned, migratingIn: health.migratingIn ?? [] },
        { streaks, inFlight },
      );
    } catch (err) {
      deps.log(`[operator-poll] ⚠ ${gatewayId}: ${errMsg(err)} — will retry next tick`);
    }
  }
}

export function startOperatorHeartbeatPoller(
  deps: OperatorHeartbeatPollerDeps,
  intervalMs: number,
): () => void {
  const streaks: EvictionStreaks = new Map();
  const inFlight: EvictionInFlight = new Set();
  const timer = setInterval(
    () => void pollOperatorHeartbeatsOnce(deps, streaks, inFlight),
    intervalMs,
  );
  return () => clearInterval(timer);
}
