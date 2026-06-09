/**
 * Pull-model fleet reporting for operator gateways (OPERATOR-GATEWAY-PULL-REPORTING).
 *
 * Operator gateways are customer-controlled and run the agent with a
 * danger-full-access sandbox, so they must NOT hold broad Firestore IAM — a
 * shelled or prompt-injected pod could read every tenant's data. Instead of the
 * pod writing its own `gateways/{id}` heartbeat, Cowboy (the trusted fleet
 * authority) polls each operator gateway's `/health` for the locally-present
 * customer set, intersects it with the assigned roster on the trusted side, and
 * writes the live telemetry itself. The gateway needs zero platform credentials.
 *
 * Identity fields (version/startedAt/internalUrl, status=ready) stay owned by the
 * reconcile path (publishPlatformGatewayReady). This poller owns only the live
 * telemetry — status, the honest mounted set, and lastHeartbeatAt — and a
 * successful poll IS the liveness signal (it only writes when /health responds).
 */

export interface OperatorGatewayHealth {
  status: string;
  /** Slugs the pod actually has on disk + coach-wired — reported Firestore-free. */
  customers: string[];
}

export interface OperatorHeartbeatRecord {
  status: string;
  mountedCustomers: string[];
}

export interface OperatorHeartbeatPollerDeps {
  /** Operator-profile gateways Cowboy should report for (running/desired-live). */
  listOperatorGatewayIds: () => Promise<string[]>;
  /** GET the gateway's /health; null when unreachable (do not clobber the doc). */
  fetchHealth: (gatewayId: string) => Promise<OperatorGatewayHealth | null>;
  /** Slugs assigned to this gateway in Firestore (users gatewayId==id, complete). */
  readAssignedSlugs: (gatewayId: string) => Promise<string[]>;
  /** Persist live telemetry; the impl stamps lastHeartbeatAt. */
  writeHeartbeat: (gatewayId: string, record: OperatorHeartbeatRecord) => Promise<void>;
  log: (msg: string) => void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse + validate a gateway /health body. Returns null for anything malformed
 * (non-object, missing/empty status, non-array customers) so the poller treats a
 * garbled /health like an unreachable gateway — it never writes fabricated state.
 */
export function parseHealthResponse(json: unknown): OperatorGatewayHealth | null {
  if (typeof json !== "object" || json === null) return null;
  const body = json as { status?: unknown; customers?: unknown };
  if (typeof body.status !== "string" || body.status.length === 0) return null;
  if (!Array.isArray(body.customers)) return null;
  const customers = body.customers.filter(
    (slug): slug is string => typeof slug === "string",
  );
  return { status: body.status, customers };
}

/** The honest mounted set: locally-present customers that are still assigned here. */
export function intersectMounted(present: string[], assigned: string[]): string[] {
  const assignedSet = new Set(assigned);
  return present
    .filter((slug) => assignedSet.has(slug))
    .sort((a, b) => a.localeCompare(b));
}

export async function pollOperatorHeartbeatsOnce(
  deps: OperatorHeartbeatPollerDeps,
): Promise<void> {
  let gatewayIds: string[];
  try {
    gatewayIds = await deps.listOperatorGatewayIds();
  } catch (err) {
    deps.log(`[operator-poll] ⚠ failed to list operator gateways: ${errMsg(err)}`);
    return;
  }

  for (const gatewayId of gatewayIds) {
    try {
      const health = await deps.fetchHealth(gatewayId);
      if (!health) continue;
      const assigned = await deps.readAssignedSlugs(gatewayId);
      await deps.writeHeartbeat(gatewayId, {
        status: health.status,
        mountedCustomers: intersectMounted(health.customers, assigned),
      });
    } catch (err) {
      deps.log(`[operator-poll] ⚠ ${gatewayId}: ${errMsg(err)} — will retry next tick`);
    }
  }
}

export function startOperatorHeartbeatPoller(
  deps: OperatorHeartbeatPollerDeps,
  intervalMs: number,
): () => void {
  const timer = setInterval(() => void pollOperatorHeartbeatsOnce(deps), intervalMs);
  return () => clearInterval(timer);
}
