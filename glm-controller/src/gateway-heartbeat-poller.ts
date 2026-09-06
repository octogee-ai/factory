/**
 * Pull-model fleet reporting + eviction for db-less gateways.
 *
 * Gateway pods hold NO platform Firestore credentials. The pod cannot read the
 * assigned roster directly or write its own heartbeat. Instead, Cowboy (the
 * trusted fleet authority) polls each gateway's signed `/fleet-state` for its
 * locally-present coach-wired customers, and does the trusted-side roster work:
 *  - reporting: writes gateways/{id}.mountedCustomers = present ∩ assigned;
 *  - eviction: tears down a departed customer's LOCAL footprint (present − assigned)
 *    by calling the pod's existing /unmount RPC — a local-only teardown that needs
 *    no platform credentials. Debounced by a consecutive-streak so a transient
 *    assigned-state blip never blind-evicts.
 *
 * The roster is signature-gated because the unauthenticated `/health` probe on the
 * same port is reachable by every pod the fleet ingress policy admits.
 *
 * Identity fields (version/startedAt/internalUrl, status=ready) stay owned by the
 * reconcile path (publishPlatformGatewayReady). This poller owns the live telemetry
 * — status, the honest mounted set, lastHeartbeatAt — and a successful poll IS the
 * liveness signal (it only writes when /fleet-state responds).
*/

export const EVICT_AFTER_STREAK = 2;

export interface GatewayFleetState {
  status: string;
  version?: string;
  openclawVersion?: string;
  /** The pod's current process start (epoch ms). Optional — omitted by a malformed /health. */
  startedAt?: number;
  /** Slugs the pod actually has on disk + coach-wired — reported Firestore-free. */
  customers: string[];
  /** Slugs mid-migration-import (coach-wired here but cutover hasn't moved their assignment
   *  yet). Skipped as eviction candidates so a slow import→cutover isn't drained. */
  migratingIn?: string[];
}

export interface GatewayHeartbeatRecord {
  status: string;
  mountedCustomers: string[];
  version?: string;
  openclawVersion?: string;
  /** Live pod-boot time (epoch ms). */
  startedAt?: number;
}

export interface GatewayHeartbeatPollerDeps {
  /** Gateways Cowboy should report for (running/desired-live). */
  listGatewayIds: () => Promise<string[]>;
  /** Signed read of the gateway's /fleet-state; null when unreachable (do not clobber the doc). */
  fetchFleetState: (gatewayId: string) => Promise<GatewayFleetState | null>;
  /** Slugs assigned to this gateway in Firestore (users gatewayId==id, complete). */
  readAssignedSlugs: (gatewayId: string) => Promise<string[]>;
  /** Persist live telemetry; the impl stamps lastHeartbeatAt. */
  writeHeartbeat: (gatewayId: string, record: GatewayHeartbeatRecord) => Promise<void>;
  /** Reconcile a gateway whose signed fleet-state endpoint is not reachable yet. */
  onUnreachable?: (gatewayId: string) => Promise<void> | void;
  ownsEviction?: (gatewayId: string) => Promise<boolean>;
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
 * Parse + validate a gateway /fleet-state body. Returns null for anything malformed
 * (non-object, missing/empty status, non-array customers) so the poller treats a
 * garbled body like an unreachable gateway — it never writes fabricated state.
 */
export function parseFleetStateResponse(json: unknown): GatewayFleetState | null {
  if (typeof json !== "object" || json === null) return null;
  const body = json as {
    status?: unknown;
    customers?: unknown;
    startedAt?: unknown;
    version?: unknown;
    openclawVersion?: unknown;
    migratingIn?: unknown;
  };
  if (typeof body.status !== "string" || body.status.length === 0) return null;
  if (!Array.isArray(body.customers)) return null;
  const customers = body.customers.filter(
    (slug): slug is string => typeof slug === "string",
  );
  return {
    status: body.status,
    customers,
    ...stateStringField("version", body.version, false),
    ...stateStringField("openclawVersion", body.openclawVersion, true),
    ...(typeof body.startedAt === "number" ? { startedAt: body.startedAt } : {}),
    ...(Array.isArray(body.migratingIn)
      ? { migratingIn: body.migratingIn.filter(isString) }
      : {}),
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function stateStringField<K extends "version" | "openclawVersion">(
  key: K,
  value: unknown,
  requireNonEmpty: boolean,
): Partial<Pick<GatewayFleetState, K>> {
  if (typeof value !== "string" || (requireNonEmpty && value.length === 0)) return {};
  return { [key]: value } as Partial<Pick<GatewayFleetState, K>>;
}

async function evictDepartedForGateway(
  deps: GatewayHeartbeatPollerDeps,
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
        `[gateway-poll] ${gatewayId}/${slug} eviction already in flight — skipping duplicate`,
      );
      continue;
    }
    state.inFlight.add(flightKey);
    try {
      await deps.evictSlug(gatewayId, slug);
    } catch (err) {
      deps.log(
        `[gateway-poll] ⚠ evict ${gatewayId}/${slug}: ${errMsg(err)} — will retry next tick`,
      );
    } finally {
      state.inFlight.delete(flightKey);
    }
  }
}

export async function pollGatewayHeartbeatsOnce(
  deps: GatewayHeartbeatPollerDeps,
  streaks: EvictionStreaks = new Map(),
  inFlight: EvictionInFlight = new Set(),
): Promise<void> {
  let gatewayIds: string[];
  try {
    gatewayIds = await deps.listGatewayIds();
  } catch (err) {
    deps.log(`[gateway-poll] ⚠ failed to list gateways: ${errMsg(err)}`);
    return;
  }

  for (const gatewayId of gatewayIds) {
    try {
      const state = await deps.fetchFleetState(gatewayId);
      if (!state) {
        await deps.onUnreachable?.(gatewayId);
        continue;
      }
      const assigned = await deps.readAssignedSlugs(gatewayId);
      const record: GatewayHeartbeatRecord = {
        status: state.status,
        mountedCustomers: intersectMounted(state.customers, assigned),
      };
      if (typeof state.version === "string") record.version = state.version;
      if (typeof state.openclawVersion === "string") {
        record.openclawVersion = state.openclawVersion;
      }
      if (typeof state.startedAt === "number") record.startedAt = state.startedAt;
      await deps.writeHeartbeat(gatewayId, record);
      if (deps.ownsEviction && !(await deps.ownsEviction(gatewayId))) {
        streaks.delete(gatewayId);
        continue;
      }
      await evictDepartedForGateway(
        deps,
        gatewayId,
        { footprint: state.customers, assigned, migratingIn: state.migratingIn ?? [] },
        { streaks, inFlight },
      );
    } catch (err) {
      deps.log(`[gateway-poll] ⚠ ${gatewayId}: ${errMsg(err)} — will retry next tick`);
    }
  }
}

export function startGatewayHeartbeatPoller(
  deps: GatewayHeartbeatPollerDeps,
  intervalMs: number,
): () => void {
  const streaks: EvictionStreaks = new Map();
  const inFlight: EvictionInFlight = new Set();
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void pollGatewayHeartbeatsOnce(deps, streaks, inFlight)
      .catch((error) => deps.log(`[gateway-poll] ⚠ tick failed: ${errMsg(error)}`))
      .finally(() => { running = false; });
  }, intervalMs);
  return () => clearInterval(timer);
}
