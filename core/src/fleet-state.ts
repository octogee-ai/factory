import {
  type GatewayStatus,
  GATEWAYS_COLLECTION,
} from "@octogee/shared/types/fleet-controller";
import {
  GLM_GATEWAYS_COLLECTION,
  resolveUserGatewayShellState,
} from "@octogee/shared/types/glm";
import {
  GATEWAY_ASSIGNMENTS_SUBCOLLECTION,
  type AssignmentSource,
  type AssignmentState,
} from "@octogee/shared/types/gateway-releases";

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
  // The atomic cutover reaches a subcollection ref (gateways/{gw}/assignments/{uid});
  // the real firebase-admin DocumentReference supports this.
  collection?: (name: string) => { doc: (id: string) => FleetStateDocRef };
}

export interface FleetStateTxn {
  get: (ref: FleetStateDocRef) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  update: (ref: FleetStateDocRef, data: Record<string, unknown>) => void;
  set: (ref: FleetStateDocRef, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
  delete: (ref: FleetStateDocRef) => void;
}

export interface FleetStateFirestore {
  collection: (name: string) => {
    doc: (id: string) => FleetStateDocRef;
  };
  runTransaction: <T>(body: (txn: FleetStateTxn) => Promise<T>) => Promise<T>;
}

export interface HeartbeatSnapshot {
  gatewayId: string;
  // Set from the pod's GATEWAY_REVISION_ID (PR3 env). When present the heartbeat
  // is ALSO written to glmGateways/{revisionId}.heartbeat — the readiness key
  // Cowboy's converge-empty arm matches (glm-controller/src/converge-empty.ts).
  // Absent on legacy pods that predate the revision env.
  revisionId?: string;
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
  // Heartbeat/readiness telemetry lives only at glmGateways/{id}.heartbeat
  // (GATEWAY-RELEASES-SPEC cutover step 2 — the collision fix that frees
  // gateways/{id} to become the desired-doc collection). The legacy flat
  // gateways/{id} dual-write is retired: a per-tick flat write recreates the
  // heartbeat fields the identity backfill refuses on, so it could never run.
  //
  // The lastKnownBuilders billing mirror runs FIRST so its orphan guard checks
  // the desired-doc state BEFORE this heartbeat merges the revision doc.
  await mirrorMountedCustomersToGlm(deps, snapshot);

  const heartbeat = {
    status: snapshot.status,
    version: snapshot.version,
    openclawVersion: snapshot.openclawVersion,
    mountedCustomers: snapshot.mountedCustomers,
    internalUrl: snapshot.internalUrl,
    startedAt: snapshot.startedAt,
    lastHeartbeatAt: deps.serverTimestamp(),
  };
  await deps.db
    .collection(GLM_GATEWAYS_COLLECTION)
    .doc(snapshot.gatewayId)
    .set({ heartbeat }, { merge: true });

  // Revision-keyed heartbeat (GATEWAY-RELEASES-SPEC): converge-empty's readiness
  // check matches glmGateways/{revisionId}.heartbeat.version, so a revision-only
  // gateway can only go live once this write lands. Skip when the revision id is
  // absent (legacy pod) or already equal to the bare gateway id.
  if (snapshot.revisionId && snapshot.revisionId !== snapshot.gatewayId) {
    await deps.db
      .collection(GLM_GATEWAYS_COLLECTION)
      .doc(snapshot.revisionId)
      .set({ heartbeat }, { merge: true });
  }
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
      "provisioning.openclaw.gatewayAssignedAt": deps.serverTimestamp(),
      "provisioning.openclaw.gatewayProfile": shellState.gatewayProfile,
      "provisioning.openclaw.shellsEnabled": shellState.shellsEnabled,
    });
  });
}

export interface CutoverCommitParams {
  uid: string;
  slug: string;
  // The bare gateway the cutover moves TO / FROM (revision drains keep these equal).
  toGatewayId: string;
  fromGatewayId: string;
  // Move the users/{uid} mirror — only when the bare gateway changed. A
  // same-gateway revision drain leaves the mirror bare (flipMirror=false).
  flipMirror: boolean;
  // The assignment revision to commit (null = legacy migration, no assignment
  // layer). source/updatedByOperationId are resolved by the caller.
  assignment: {
    revisionId: string;
    release: number;
    source: AssignmentSource;
    updatedByOperationId: string | null;
  } | null;
}

// Atomic cutover (GATEWAY-RELEASES-SPEC, PR5 review P0). The mirror move AND the
// assignment write commit in ONE Firestore transaction, so a crash/throw leaves
// NEITHER — never a half-state where the mirror points at the target while the
// assignment still says source (which would make the target pod treat the
// customer as a gap user and mount them on the wrong revision). Cross-gateway
// also drops the stale source assignment in the same transaction.
//
// PR7: the commit is also the ROSTER FLIP. The written assignment is stamped
// state:"serving" and its epoch is bumped past the customer's prior assignment
// (source-gateway doc when cross-gateway, same doc on a revision drain) — the
// per-customer monotonic epoch the edge's intra-family forwarding rides.
export async function commitCutoverAtomic(
  deps: FleetStateDeps,
  params: CutoverCommitParams,
): Promise<void> {
  const nowMs = deps.now ? deps.now().getTime() : Date.now();
  await deps.db.runTransaction(async (txn) => {
    let priorEpoch = 0;
    if (params.assignment) {
      const priorSnap = await txn.get(
        assignmentRef(deps.db, params.fromGatewayId, params.uid),
      );
      const rawEpoch = priorSnap.exists ? priorSnap.data()?.epoch : undefined;
      priorEpoch = typeof rawEpoch === "number" && rawEpoch >= 0 ? rawEpoch : 0;
    }
    if (params.flipMirror) {
      const glmSnap = await txn.get(
        deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(params.toGatewayId),
      );
      const shellState = resolveUserGatewayShellState(
        glmSnap.exists ? glmSnap.data() : undefined,
        params.uid,
      );
      txn.update(deps.db.collection("users").doc(params.uid), {
        "provisioning.openclaw.gatewayId": params.toGatewayId,
        "provisioning.openclaw.gatewayAssignedAt": deps.serverTimestamp(),
        "provisioning.openclaw.gatewayProfile": shellState.gatewayProfile,
        "provisioning.openclaw.shellsEnabled": shellState.shellsEnabled,
      });
    }
    if (params.assignment) {
      txn.set(assignmentRef(deps.db, params.toGatewayId, params.uid), {
        uid: params.uid,
        slug: params.slug,
        gatewayId: params.toGatewayId,
        revisionId: params.assignment.revisionId,
        release: params.assignment.release,
        source: params.assignment.source,
        state: "serving" satisfies AssignmentState,
        epoch: priorEpoch + 1,
        updatedAt: nowMs,
        updatedByOperationId: params.assignment.updatedByOperationId,
      });
      if (params.fromGatewayId !== params.toGatewayId) {
        txn.delete(assignmentRef(deps.db, params.fromGatewayId, params.uid));
      }
    }
  });
}

export interface MarkAssignmentStateParams {
  gatewayId: string;
  uid: string;
  state: AssignmentState;
}

// Flip ONLY the roster state on an existing assignment — revision and epoch
// stay put. The gated quiesce writes "quiescing" here BEFORE the source pod is
// quiesced (blocking source serving ahead of the target ever serving — no
// double-serve window); a pre-cutover rollback writes "serving" to restore the
// source. No-op when the customer has no assignment doc (legacy migration):
// there is no roster entry for the edge to consult, so nothing to gate.
export async function markAssignmentState(
  deps: FleetStateDeps,
  params: MarkAssignmentStateParams,
): Promise<void> {
  await deps.db.runTransaction(async (txn) => {
    const ref = assignmentRef(deps.db, params.gatewayId, params.uid);
    const snap = await txn.get(ref);
    if (!snap.exists) return;
    txn.update(ref, { state: params.state });
  });
}

function assignmentRef(
  db: FleetStateFirestore,
  gatewayId: string,
  uid: string,
): FleetStateDocRef {
  const gatewayDoc = db.collection(GATEWAYS_COLLECTION).doc(gatewayId);
  if (!gatewayDoc.collection) {
    throw new Error("FleetStateFirestore doc ref does not support subcollections");
  }
  return gatewayDoc.collection(GATEWAY_ASSIGNMENTS_SUBCOLLECTION).doc(uid);
}
