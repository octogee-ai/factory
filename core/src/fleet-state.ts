import {
  type GatewayState,
  type GatewayStatus,
  GATEWAYS_COLLECTION,
} from "@octogee/shared/types/fleet-controller";
import {
  GLM_GATEWAYS_COLLECTION,
  resolveUserGatewayShellState,
} from "@octogee/shared/types/glm";

export interface FleetStateDeps {
  db: FleetStateFirestore;
  serverTimestamp: () => unknown;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface FleetStateDocRef {
  set: (data: Record<string, unknown>, options?: { merge?: boolean }) => Promise<unknown>;
  update: (data: Record<string, unknown>) => Promise<unknown>;
  get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
}

export interface FleetStateTxn {
  get: (ref: FleetStateDocRef) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  update: (ref: FleetStateDocRef, data: Record<string, unknown>) => void;
  set: (ref: FleetStateDocRef, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
}

export interface FleetStateFirestore {
  collection: (name: string) => {
    doc: (id: string) => FleetStateDocRef;
  };
  runTransaction: <T>(body: (txn: FleetStateTxn) => Promise<T>) => Promise<T>;
}

export interface HeartbeatSnapshot {
  gatewayId: string;
  status: GatewayStatus;
  version: string;
  openclawVersion: string;
  mountedCustomers: string[];
  internalUrl: string;
  startedAt: number;
}

export interface CutoverUserGatewayParams {
  uid: string;
  slug: string;
  toGatewayId: string;
}

export async function writeGatewayHeartbeat(
  deps: FleetStateDeps,
  snapshot: HeartbeatSnapshot,
): Promise<void> {
  const data: Partial<GatewayState> & { lastHeartbeatAt: unknown } = {
    gatewayId: snapshot.gatewayId,
    status: snapshot.status,
    version: snapshot.version,
    openclawVersion: snapshot.openclawVersion,
    mountedCustomers: snapshot.mountedCustomers,
    internalUrl: snapshot.internalUrl,
    startedAt: snapshot.startedAt,
    lastHeartbeatAt: deps.serverTimestamp(),
  };
  await deps.db
    .collection(GATEWAYS_COLLECTION)
    .doc(snapshot.gatewayId)
    .set(data as Record<string, unknown>, { merge: true });
  await mirrorMountedCustomersToGlm(deps, snapshot);
}

// Phase D hand-off for GATEWAY-PLATFORM-SPEC §5a billing: mirror the live
// mounted set onto the desired-state doc so chargeback roll-ups read a
// static snapshot next to sizingTier. Best-effort — failures here MUST
// NOT propagate, otherwise a transient Firestore hiccup marks the
// heartbeat as failed and the gateway looks dead.
//
// CRITICAL: this writes to glmGateways, which is exactly the collection
// the reconciler watches. Writing every 15s would trigger a full
// reconcile tick (helm list + ingress sync) on every heartbeat. So we
// read first, diff against the live mounted set, and only write when it
// actually changed. Steady-state heartbeats then cost 1 read + 0
// writes per gateway. The reconciler only ticks when membership
// genuinely shifts (provision, deprovision, migrate).
async function mirrorMountedCustomersToGlm(
  deps: FleetStateDeps,
  snapshot: HeartbeatSnapshot,
): Promise<void> {
  try {
    const ref = deps.db
      .collection(GLM_GATEWAYS_COLLECTION)
      .doc(snapshot.gatewayId);
    const existing = await ref.get();
    if (!existing.exists) {
      deps.log?.(
        `[fleet-state] glmGateways/${snapshot.gatewayId} not found — skipping lastKnownBuilders mirror (Cowboy owns desired-state doc creation)`,
      );
      return;
    }
    const prev = existing.data();
    const prevBuilders = Array.isArray(prev?.lastKnownBuilders)
      ? (prev!.lastKnownBuilders as string[])
      : null;
    if (mountedSetEqual(prevBuilders, snapshot.mountedCustomers)) {
      // No-op — avoids the reconciler-thrash that a per-heartbeat write
      // would cause on the watched glmGateways collection.
      return;
    }
    await ref.update({
      lastKnownBuilders: snapshot.mountedCustomers,
      lastKnownBuildersAt: deps.serverTimestamp(),
    });
  } catch (err) {
    deps.log?.(
      `[fleet-state] lastKnownBuilders mirror failed for ${snapshot.gatewayId} — eventual-consistency catches up on next heartbeat: ${(err as Error).message}`,
    );
  }
}

function mountedSetEqual(a: readonly string[] | null, b: readonly string[]): boolean {
  if (a === null) return false;
  if (a.length !== b.length) return false;
  const aSet = new Set(a);
  for (const slug of b) {
    if (!aSet.has(slug)) return false;
  }
  return true;
}

// Migration cutover: move the customer's DESIRED assignment to the target gateway.
// Mounting and the mounted-set report are the reconcile/heartbeat's job (observed) —
// cutover only flips desired, so the source gateway evicts and the target mounts on
// their next reconcile tick. See FLEET-RECONCILE-SPEC. The mirrored user-doc shell
// state (gatewayProfile + shellsEnabled, read by the PWA) derives from the target
// gateway's class + this user's ownership — see resolveUserGatewayShellState.
export async function cutoverUserGatewayAndMarkMounted(
  deps: FleetStateDeps,
  params: CutoverUserGatewayParams,
): Promise<void> {
  const userRef = deps.db.collection("users").doc(params.uid);
  await deps.db.runTransaction(async (txn) => {
    const snap = await txn.get(
      deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(params.toGatewayId),
    );
    const shellState = resolveUserGatewayShellState(
      snap.exists ? snap.data() : undefined,
      params.uid,
    );
    txn.update(userRef, {
      "provisioning.openclaw.gatewayId": params.toGatewayId,
      "provisioning.openclaw.gatewayProfile": shellState.gatewayProfile,
      "provisioning.openclaw.shellsEnabled": shellState.shellsEnabled,
    });
  });
}
