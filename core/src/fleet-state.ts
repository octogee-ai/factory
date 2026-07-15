import {
  type GatewayStatus,
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  GATEWAY_UNREACHABLE_AFTER_MS,
  GATEWAYS_COLLECTION,
  hasDurableOpenClawConfigControlProtocol,
} from "@octogee/shared/types/fleet-controller";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
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
  // Every pod realizes one disposable revision. Telemetry belongs only on that
  // realization, never on a bare gateway identity record.
  revisionId: string;
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
  if (!snapshot.revisionId) {
    throw new Error("revisionId is required for revision-scoped gateway heartbeat");
  }

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
    .doc(snapshot.revisionId)
    .set({ heartbeat }, { merge: true });
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
      deps.db.collection(GATEWAYS_COLLECTION).doc(params.toGatewayId),
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
  rollFence?: {
    operationId: string;
    targetRevisionId: string;
    targetRelease: number;
    sourceRevisionId: string;
    sourceEpoch: number;
    sourceConfigCheckpoint?: {
      migrationId: string;
      checkpointCommit: string;
      configHash: string;
    };
    configReady?: {
      observedRevisionId: string;
      acceptedCommit: string;
      configReadyAt: number;
      runtimeConfigHash: string;
    };
  };
  customerMigrationV2Fence?: {
    operationId: string;
    migrationId: string;
    uid: string;
    slug: string;
    sourceGatewayId: string;
    sourceRevisionId: string;
    sourceEpoch: number;
    targetGatewayId: string;
    targetRevisionId: string;
    targetRelease: number;
    checkpointCommit: string;
    configHash: string;
    freezeObject: string;
    candidateCommit: string;
    candidateHash: string;
    runtimeConfigHash: string;
    targetStartedAt: number;
    imageTag: string;
    buildSha: string;
    openclawVersion: string;
    provenAt: number;
  };
}

function protocolV2PromotionIsExact(
  configRoll: Record<string, unknown> | null,
  operationId: string,
  sourceRevisionId: string,
  targetRevisionId: string,
): configRoll is Record<string, unknown> {
  if (!configRoll) return false;
  return [
    configRoll.phase === "promoted",
    configRoll.migrationId === `roll-config-${operationId}`,
    configRoll.sourceRevisionId === sourceRevisionId,
    configRoll.targetRevisionId === targetRevisionId,
    configRoll.freezeRef === `refs/octogee/system-config/freeze/${sourceRevisionId}`,
    typeof configRoll.freezeObject === "string" && /^[0-9a-f]{40}$/.test(configRoll.freezeObject),
    typeof configRoll.checkpointCommit === "string" && /^[0-9a-f]{40}$/.test(configRoll.checkpointCommit),
    typeof configRoll.configHash === "string" && /^[0-9a-f]{64}$/.test(configRoll.configHash),
    configRoll.candidateRef === `refs/octogee/system-config/candidate/${targetRevisionId}`,
    typeof configRoll.candidateCommit === "string" && /^[0-9a-f]{40}$/.test(configRoll.candidateCommit),
    typeof configRoll.candidateHash === "string" && /^[0-9a-f]{64}$/.test(configRoll.candidateHash),
    typeof configRoll.runtimeConfigHash === "string" && /^[0-9a-f]{64}$/.test(configRoll.runtimeConfigHash),
    configRoll.observedRevisionId === targetRevisionId,
    typeof configRoll.targetStartedAt === "number",
    typeof configRoll.imageTag === "string" && configRoll.imageTag.length > 0,
    typeof configRoll.buildSha === "string" && configRoll.buildSha.length > 0,
    typeof configRoll.openclawVersion === "string" && configRoll.openclawVersion.length > 0,
    typeof configRoll.provenAt === "number",
    configRoll.promotedCommit === configRoll.candidateCommit,
    typeof configRoll.promotedAt === "number" &&
      typeof configRoll.provenAt === "number" &&
      configRoll.promotedAt >= configRoll.provenAt,
  ].every(Boolean);
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function protocolV2TargetProofIsCurrent(
  configRoll: Record<string, unknown>,
  target: Record<string, unknown> | undefined,
  input: { gatewayId: string; revisionId: string; release: number; now: number },
): boolean {
  const targetRecord = recordOrEmpty(target);
  const helm = recordOrEmpty(targetRecord.helm);
  const heartbeat = recordOrEmpty(targetRecord.heartbeat);
  const status = recordOrEmpty(heartbeat.configStatus);
  const owner = recordOrEmpty(status.controlOwner);
  const lastHeartbeatAt = millis(heartbeat.lastHeartbeatAt);
  const configObservedAt = millis(status.observedAt);
  return [
    targetRecord.docKind === "revision",
    targetRecord.gateway === input.gatewayId,
    targetRecord.revisionId === input.revisionId,
    targetRecord.release === input.release,
    helm.imageTag === configRoll.imageTag,
    heartbeat.status === "ready",
    freshObservation(lastHeartbeatAt, input.now),
    heartbeat.startedAt === configRoll.targetStartedAt,
    heartbeat.version === configRoll.buildSha,
    hasDurableOpenClawConfigControlProtocol(status),
    freshObservation(configObservedAt, input.now),
    status.runtimeReady === true,
    status.openclawVersion === configRoll.openclawVersion,
    status.bootRole === "target-candidate",
    owner.migrationId === configRoll.migrationId,
    owner.sourceRevisionId === configRoll.sourceRevisionId,
    owner.targetRevisionId === configRoll.targetRevisionId,
    status.checkpointCommit === configRoll.checkpointCommit,
    status.configHash === configRoll.configHash,
    status.candidateCommit === configRoll.candidateCommit,
    status.candidateHash === configRoll.candidateHash,
  ].every(Boolean);
}

function millis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    try {
      const result = (value as { toMillis: () => unknown }).toMillis();
      return typeof result === "number" && Number.isFinite(result) ? result : null;
    } catch {
      return null;
    }
  }
  return null;
}

function freshObservation(observedAt: number | null, now: number): boolean {
  return observedAt !== null &&
    observedAt <= now + GATEWAY_HEARTBEAT_INTERVAL_MS &&
    now - observedAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}

function customerMigrationV2FenceIsExact(
  operation: Record<string, unknown> | undefined,
  fence: NonNullable<CutoverCommitParams["customerMigrationV2Fence"]>,
): boolean {
  const state = recordOrEmpty(operation?.customerMigrationV2);
  const proof = recordOrEmpty(state.candidateProof);
  return [
    operation?.status === "running",
    state.phase === "promoted",
    state.operationId === fence.operationId,
    state.migrationId === fence.migrationId,
    state.uid === fence.uid,
    state.slug === fence.slug,
    state.sourceGatewayId === fence.sourceGatewayId,
    state.sourceRevisionId === fence.sourceRevisionId,
    state.sourceEpoch === fence.sourceEpoch,
    state.targetGatewayId === fence.targetGatewayId,
    state.targetRevisionId === fence.targetRevisionId,
    state.targetRelease === fence.targetRelease,
    state.checkpointCommit === fence.checkpointCommit,
    state.configHash === fence.configHash,
    state.freezeObject === fence.freezeObject,
    proof.migrationId === fence.migrationId,
    proof.slug === fence.slug,
    proof.sourceRevisionId === fence.sourceRevisionId,
    proof.targetRevisionId === fence.targetRevisionId,
    proof.checkpointCommit === fence.checkpointCommit,
    proof.freezeObject === fence.freezeObject,
    proof.candidateCommit === fence.candidateCommit,
    proof.candidateHash === fence.candidateHash,
    proof.runtimeConfigHash === fence.runtimeConfigHash,
    proof.observedRevisionId === fence.targetRevisionId,
    proof.targetStartedAt === fence.targetStartedAt,
    proof.imageTag === fence.imageTag,
    proof.buildSha === fence.buildSha,
    proof.openclawVersion === fence.openclawVersion,
    proof.provenAt === fence.provenAt,
    typeof state.promotionIntentAt === "number",
    typeof state.promotedAt === "number",
  ].every(Boolean);
}

function customerMigrationV2TargetIsCurrent(
  target: Record<string, unknown> | undefined,
  fence: NonNullable<CutoverCommitParams["customerMigrationV2Fence"]>,
): boolean {
  const helm = recordOrEmpty(target?.helm);
  const heartbeat = recordOrEmpty(target?.heartbeat);
  const status = recordOrEmpty(heartbeat.configStatus);
  const owner = recordOrEmpty(status.controlOwner);
  return [
    helm.imageTag === fence.imageTag,
    heartbeat.startedAt === fence.targetStartedAt,
    heartbeat.version === fence.buildSha,
    status.openclawVersion === fence.openclawVersion,
    status.bootRole === "target-candidate",
    owner.migrationId === fence.migrationId,
    owner.sourceRevisionId === fence.sourceRevisionId,
    owner.targetRevisionId === fence.targetRevisionId,
    status.checkpointCommit === fence.checkpointCommit,
    status.candidateCommit === fence.candidateCommit,
    status.candidateHash === fence.candidateHash,
  ].every(Boolean);
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
    let priorRevisionId: unknown;
    let priorAssignmentExists = false;
    if (params.assignment) {
      const priorSnap = await txn.get(
        assignmentRef(deps.db, params.fromGatewayId, params.uid),
      );
      priorAssignmentExists = priorSnap.exists;
      const rawEpoch = priorSnap.exists ? priorSnap.data()?.epoch : undefined;
      priorEpoch = typeof rawEpoch === "number" && rawEpoch >= 0 ? rawEpoch : 0;
      priorRevisionId = priorSnap.exists ? priorSnap.data()?.revisionId : undefined;
    }
    const targetRootSnap = await txn.get(
      deps.db.collection(GATEWAYS_COLLECTION).doc(params.toGatewayId),
    );
    const targetRoot = targetRootSnap.exists ? targetRootSnap.data() : undefined;
    if (targetRoot?.desiredStatus === "retired" || targetRoot?.retirementClaim != null) {
      throw new Error(`gateway ${params.toGatewayId} has a current retirement claim`);
    }
    if (params.customerMigrationV2Fence) {
      const fence = params.customerMigrationV2Fence;
      if (
        fence.uid !== params.uid ||
        fence.slug !== params.slug ||
        fence.sourceGatewayId !== params.fromGatewayId ||
        fence.targetGatewayId !== params.toGatewayId ||
        params.assignment?.revisionId !== fence.targetRevisionId ||
        params.assignment.release !== fence.targetRelease
      ) {
        throw new Error("ordinary protocol-v2 cutover parameters changed after proof");
      }
      const [operationSnap, targetSnap, targetAssignmentSnap] = await Promise.all([
        txn.get(deps.db.collection(GLM_OPERATIONS_COLLECTION).doc(fence.operationId)),
        txn.get(deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(fence.targetRevisionId)),
        txn.get(assignmentRef(deps.db, params.toGatewayId, params.uid)),
      ]);
      if (!customerMigrationV2FenceIsExact(
        operationSnap.exists ? operationSnap.data() : undefined,
        fence,
      )) {
        throw new Error("ordinary protocol-v2 candidate is not durably promoted at cutover");
      }
      if (!customerMigrationV2TargetIsCurrent(
        targetSnap.exists ? targetSnap.data() : undefined,
        fence,
      )) {
        throw new Error("ordinary protocol-v2 target candidate proof changed before cutover");
      }
      const targetAssignment = targetAssignmentSnap.exists ? targetAssignmentSnap.data() : undefined;
      const alreadyCommitted = !priorAssignmentExists &&
        targetAssignment?.revisionId === fence.targetRevisionId &&
        targetAssignment.updatedByOperationId === fence.operationId &&
        targetAssignment.state === "serving";
      if (alreadyCommitted) return;
      if (
        priorRevisionId !== fence.sourceRevisionId ||
        priorEpoch !== fence.sourceEpoch
      ) {
        throw new Error("ordinary protocol-v2 source assignment changed before cutover");
      }
    }
    if (params.rollFence) {
      const root = targetRoot;
      const roll = root?.roll as Record<string, unknown> | undefined;
      const protocolV2Roll = roll?.systemConfigRoll !== undefined;
      const current =
        (protocolV2Roll || root?.desiredRelease === params.rollFence.targetRelease) &&
        roll?.operationId === params.rollFence.operationId &&
        roll?.targetRevisionId === params.rollFence.targetRevisionId &&
        roll?.toRelease === params.rollFence.targetRelease &&
        params.assignment?.revisionId === params.rollFence.targetRevisionId;
      if (!current) {
        throw new Error("stale release-roll fence refused cutover");
      }
      if (protocolV2Roll) {
        const configRoll = roll.systemConfigRoll as Record<string, unknown> | null;
        if (!protocolV2PromotionIsExact(
          configRoll,
          params.rollFence.operationId,
          params.rollFence.sourceRevisionId,
          params.rollFence.targetRevisionId,
        )) {
          throw new Error("protocol-v2 candidate is not durably promoted at cutover");
        }
        const targetSnap = await txn.get(
          deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(params.rollFence.targetRevisionId),
        );
        if (!protocolV2TargetProofIsCurrent(
          configRoll,
          targetSnap.exists ? targetSnap.data() : undefined,
          {
            gatewayId: params.toGatewayId,
            revisionId: params.rollFence.targetRevisionId,
            release: params.rollFence.targetRelease,
            now: nowMs,
          },
        )) {
          throw new Error("protocol-v2 target candidate proof changed before cutover");
        }
      }
      if (params.rollFence.sourceConfigCheckpoint) {
        const checkpoint = roll?.systemConfigCheckpoint as Record<string, unknown> | undefined;
        const expected = params.rollFence.sourceConfigCheckpoint;
        if (
          checkpoint?.migrationId !== expected.migrationId ||
          checkpoint.checkpointCommit !== expected.checkpointCommit ||
          checkpoint.configHash !== expected.configHash ||
          checkpoint.sourceUnfrozenAt !== null
        ) {
          throw new Error("source config checkpoint changed before release-roll cutover");
        }
      }
      const sourceAssignmentIsCurrent =
        priorRevisionId === params.rollFence.sourceRevisionId &&
        priorEpoch === params.rollFence.sourceEpoch;
      const sourceIsUnassignedLiveRevision =
        priorRevisionId === undefined &&
        params.rollFence.sourceEpoch === 0 &&
        root?.liveRevisionId === params.rollFence.sourceRevisionId;
      if (!sourceAssignmentIsCurrent && !sourceIsUnassignedLiveRevision) {
        throw new Error("source assignment changed after release-roll proof");
      }
      if (params.rollFence.configReady) {
        const targetSnap = await txn.get(
          deps.db
            .collection(GLM_GATEWAYS_COLLECTION)
            .doc(params.rollFence.targetRevisionId),
        );
        const target = targetSnap.exists ? targetSnap.data() : undefined;
        const systemConfig = target?.systemConfig as Record<string, unknown> | undefined;
        const heartbeat = target?.heartbeat as Record<string, unknown> | undefined;
        const proofIsCurrent =
          systemConfig?.configReady === true &&
          systemConfig.observedRevisionId === params.rollFence.configReady.observedRevisionId &&
          systemConfig.acceptedCommit === params.rollFence.configReady.acceptedCommit &&
          systemConfig.configReadyAt === params.rollFence.configReady.configReadyAt &&
          systemConfig.runtimeConfigHash === params.rollFence.configReady.runtimeConfigHash;
        if (!proofIsCurrent) {
          throw new Error("target config proof changed before release-roll cutover");
        }
        if (
          typeof heartbeat?.startedAt !== "number" ||
          heartbeat.startedAt > params.rollFence.configReady.configReadyAt
        ) {
          throw new Error("target restarted after config proof before release-roll cutover");
        }
      }
    }
    if (params.flipMirror) {
      const shellState = resolveUserGatewayShellState(
        targetRoot,
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
