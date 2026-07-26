import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";

import {
  GatewayRetirementConflictError,
  claimGatewayRetirementAtomic,
} from "@octogee/core/gateway-retirement-claim";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  resolveUserGatewayShellState,
} from "@octogee/shared/types/glm";
import {
  commitPlacementAtomic,
  isGatewayRuntimeDoc,
  projectGatewayDesiredRootForGateway,
  type PlacementFirestore,
} from "@octogee/shared/types/gateway-releases";
import {
  resolveContinuousBuilderPlacement,
  resolveLiveActivationTargetGatewayId,
  resolveOnboardingPlacementEligibility,
  type ContinuousPlacementOwnedGateway,
} from "@octogee/shared/types/orchestrator-placement";

export const PLACEMENT_POLICY_RECONCILE_MS_DEFAULT = 15_000;
const PLACEMENT_POLICY_ACTOR = "glm-controller-placement-policy";

export interface PlacementPolicyUser {
  uid: string;
  data: Record<string, unknown>;
}

export interface PlacementPolicyMigration {
  id: string;
  uid: string;
  toGatewayId: string;
}

export interface PlacementPolicyAdmission {
  schemaVersion: 1;
  reportId: string;
  classifiedAt: number;
  legacyGatewayIds: string[];
  staticGatewayIds: string[];
}

export interface PlacementPolicySnapshot {
  defaultGatewayId: string;
  admission: PlacementPolicyAdmission | null;
  users: PlacementPolicyUser[];
  gateways: ContinuousPlacementOwnedGateway[];
  activeMigrations: PlacementPolicyMigration[];
}

export interface EnqueuePlacementMigrationInput {
  uid: string;
  builderSlug: string;
  fromGatewayId: string;
  toGatewayId: string;
  source: "continuous-placement-policy";
}

export interface RetireOwnedGatewayInput {
  uid: string;
  builderSlug: string;
  gatewayId: string;
}

export interface AssignInitialPlacementInput {
  uid: string;
  builderSlug: string;
  gatewayId: string;
  gateway: ContinuousPlacementOwnedGateway;
}

export interface PlacementPolicyReconcilerDeps {
  now(): number;
  log(message: string): void;
  readSnapshot(): Promise<PlacementPolicySnapshot>;
  assignInitialPlacement(input: AssignInitialPlacementInput): Promise<void>;
  enqueueMigration(input: EnqueuePlacementMigrationInput): Promise<string>;
  retireOwnedGateway(input: RetireOwnedGatewayInput): Promise<boolean>;
}

export interface PlacementPolicyReconcileResult {
  assigned: number;
  enqueued: number;
  adopted: number;
  retired: number;
  blocked: number;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function currentGatewayId(data: Record<string, unknown>): string | null {
  const provisioning = data.provisioning;
  if (!provisioning || typeof provisioning !== "object" || Array.isArray(provisioning)) return null;
  const openclaw = (provisioning as Record<string, unknown>).openclaw;
  return openclaw && typeof openclaw === "object" && !Array.isArray(openclaw)
    ? nonEmptyString((openclaw as Record<string, unknown>).gatewayId)
    : null;
}

interface PlacementPolicyReconcileContext {
  deps: PlacementPolicyReconcilerDeps;
  state: PlacementPolicySnapshot;
  gateways: Map<string, ContinuousPlacementOwnedGateway>;
  migrations: Map<string, PlacementPolicyMigration>;
  result: PlacementPolicyReconcileResult;
  mutations: number;
  mutationLimitLogged: boolean;
}

const PLACEMENT_POLICY_MUTATION_LIMIT = 10;

function claimMutation(context: PlacementPolicyReconcileContext): boolean {
  if (context.mutations < PLACEMENT_POLICY_MUTATION_LIMIT) {
    context.mutations += 1;
    return true;
  }
  if (!context.mutationLimitLogged) {
    context.deps.log(
      `[placement-policy] mutation limit ${PLACEMENT_POLICY_MUTATION_LIMIT} reached`,
    );
    context.mutationLimitLogged = true;
  }
  return false;
}

async function retireUnentitledOwnedGateways(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
): Promise<void> {
  const ownedGateways = context.state.gateways.filter(
    (gateway) => gateway.ownerUid === user.uid &&
      gateway.gatewayClass !== "shared" &&
      gateway.disposable === true &&
      gateway.desiredStatus !== "retired",
  );
  for (const gateway of ownedGateways) {
    if (!claimMutation(context)) return;
    const retired = await context.deps.retireOwnedGateway({
      uid: user.uid,
      builderSlug,
      gatewayId: gateway.gatewayId,
    });
    if (retired) context.result.retired += 1;
    else context.result.blocked += 1;
  }
}

async function assignMissingPlacement(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  placement: ReturnType<typeof resolveContinuousBuilderPlacement>,
): Promise<void> {
  if (!claimMutation(context)) return;
  const targetGateway = context.gateways.get(placement.targetGatewayId);
  if (!targetGateway) throw new Error(`placement target ${placement.targetGatewayId} is missing`);
  await context.deps.assignInitialPlacement({
    uid: user.uid,
    builderSlug,
    gatewayId: placement.targetGatewayId,
    gateway: targetGateway,
  });
  context.result.assigned += 1;
}

function adoptActiveMigration(
  context: PlacementPolicyReconcileContext,
  uid: string,
  targetGatewayId: string,
): boolean {
  const active = context.migrations.get(uid);
  if (!active) return false;
  if (active.toGatewayId === targetGatewayId) context.result.adopted += 1;
  else context.result.blocked += 1;
  return true;
}

async function reconcileEligibleBuilder(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
): Promise<void> {
  const current = currentGatewayId(user.data);
  const currentGateway = current ? context.gateways.get(current) : null;
  if (
    currentGateway &&
    currentGateway.gatewayClass !== "shared" &&
    currentGateway.disposable !== true
  ) {
    context.result.blocked += 1;
    context.deps.log(
      `[placement-policy] uid=${user.uid} legacy gateway ${currentGateway.gatewayId} requires operator migration`,
    );
    return;
  }
  const entitledOwned = resolveLiveActivationTargetGatewayId({
    userData: user.data,
    now: new Date(context.deps.now()),
  });
  const placement = resolveContinuousBuilderPlacement({
    uid: user.uid,
    userData: user.data,
    currentGatewayId: current,
    defaultGatewayId: context.state.defaultGatewayId,
    ownedGateway: entitledOwned ? context.gateways.get(entitledOwned) ?? null : null,
    now: new Date(context.deps.now()),
  });
  if (!current) {
    await assignMissingPlacement(context, user, builderSlug, placement);
    return;
  }
  if (placement.targetGatewayId === current) {
    if (placement.ownedGatewayId === null && current === context.state.defaultGatewayId) {
      await retireUnentitledOwnedGateways(context, user, builderSlug);
    }
    return;
  }
  if (adoptActiveMigration(context, user.uid, placement.targetGatewayId)) return;
  if (!claimMutation(context)) return;
  await context.deps.enqueueMigration({
    uid: user.uid,
    builderSlug,
    fromGatewayId: current,
    toGatewayId: placement.targetGatewayId,
    source: "continuous-placement-policy",
  });
  context.result.enqueued += 1;
}

async function reconcilePlacementUser(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
): Promise<void> {
  const eligibility = resolveOnboardingPlacementEligibility(user.data);
  if (!eligibility.eligible) return;
  await reconcileEligibleBuilder(context, user, eligibility.slug);
}

export async function reconcilePlacementPolicyOnce(
  deps: PlacementPolicyReconcilerDeps,
): Promise<PlacementPolicyReconcileResult> {
  const state = await deps.readSnapshot();
  if (!state.defaultGatewayId) throw new Error("placement policy default gateway is missing");
  const result: PlacementPolicyReconcileResult = {
    assigned: 0,
    enqueued: 0,
    adopted: 0,
    retired: 0,
    blocked: 0,
  };
  if (!state.admission) {
    deps.log("[placement-policy] disabled: operator classification receipt is missing");
    return result;
  }
  const retainedNamedGatewayIds = state.gateways
    .filter(
      (gateway) =>
        gateway.gatewayClass !== "shared" &&
        gateway.disposable !== true &&
        gateway.desiredStatus !== "retired",
    )
    .map((gateway) => gateway.gatewayId)
    .sort();
  const approvedStaticGatewayIds = new Set(state.admission.staticGatewayIds);
  const unapprovedNamedGatewayIds = retainedNamedGatewayIds.filter(
    (gatewayId) => !approvedStaticGatewayIds.has(gatewayId),
  );
  if (
    state.admission.legacyGatewayIds.length > 0 ||
    unapprovedNamedGatewayIds.length > 0
  ) {
    deps.log(
      `[placement-policy] disabled: retained named gateways ${unapprovedNamedGatewayIds.join(",")}`,
    );
    return result;
  }
  const gateways = new Map(state.gateways.map((item) => [item.gatewayId, item]));
  const unknownMirrorGatewayIds = state.users
    .flatMap((user) => {
      const gatewayId = currentGatewayId(user.data);
      return gatewayId && !gateways.has(gatewayId) ? [gatewayId] : [];
    })
    .sort();
  if (unknownMirrorGatewayIds.length > 0) {
    deps.log(
      `[placement-policy] disabled: user mirrors reference missing gateways ${[...new Set(unknownMirrorGatewayIds)].join(",")}`,
    );
    return result;
  }
  const migrations = new Map(state.activeMigrations.map((item) => [item.uid, item]));

  const context = {
    deps,
    state,
    gateways,
    migrations,
    result,
    mutations: 0,
    mutationLimitLogged: false,
  };
  for (const user of [...state.users].sort((a, b) => a.uid.localeCompare(b.uid))) {
    await reconcilePlacementUser(context, user);
  }
  return result;
}

function docsById(docs: QueryDocumentSnapshot[]): Map<string, Record<string, unknown>> {
  return new Map(docs.map((doc) => [doc.id, doc.data() as Record<string, unknown>]));
}

function activeMigration(doc: QueryDocumentSnapshot): PlacementPolicyMigration | null {
  const data = doc.data() as Record<string, unknown>;
  if (data.kind !== "migrate-customer") return null;
  const input = data.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const uid = nonEmptyString((input as Record<string, unknown>).uid) ?? nonEmptyString(data.inputUid);
  const toGatewayId = nonEmptyString((input as Record<string, unknown>).toGatewayId);
  return uid && toGatewayId ? { id: doc.id, uid, toGatewayId } : null;
}

function placementPolicyAdmission(value: unknown): PlacementPolicyAdmission | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const reportId = nonEmptyString(raw.reportId);
  if (
    raw.schemaVersion !== 1 ||
    !reportId ||
    typeof raw.classifiedAt !== "number" ||
    !Number.isFinite(raw.classifiedAt) ||
    raw.classifiedAt <= 0 ||
    !Array.isArray(raw.legacyGatewayIds) ||
    raw.legacyGatewayIds.some((gatewayId) => !nonEmptyString(gatewayId)) ||
    new Set(raw.legacyGatewayIds).size !== raw.legacyGatewayIds.length ||
    !Array.isArray(raw.staticGatewayIds) ||
    raw.staticGatewayIds.some((gatewayId) => !nonEmptyString(gatewayId)) ||
    new Set(raw.staticGatewayIds).size !== raw.staticGatewayIds.length
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    reportId,
    classifiedAt: raw.classifiedAt,
    legacyGatewayIds: [...raw.legacyGatewayIds].sort() as string[],
    staticGatewayIds: [...raw.staticGatewayIds].sort() as string[],
  };
}

interface FirestorePlacementPolicyInput {
  db: Firestore;
  now(): number;
  log(message: string): void;
}

async function readPlacementPolicySnapshot(db: Firestore): Promise<PlacementPolicySnapshot> {
  const [configSnap, usersSnap, gatewaysSnap, runtimeSnap, opsSnap] =
    await Promise.all([
      db.doc("config/orchestrator").get(),
      db.collection("users").get(),
      db.collection(GATEWAYS_COLLECTION).get(),
      db.collection(GLM_GATEWAYS_COLLECTION).get(),
      db.collection(GLM_OPERATIONS_COLLECTION).where("status", "in", ["pending", "running"]).get(),
    ]);
  const defaultGatewayId = nonEmptyString(configSnap.data()?.defaultGatewayId);
  if (!defaultGatewayId) throw new Error("config/orchestrator.defaultGatewayId is missing");
  const admission = placementPolicyAdmission(
    configSnap.data()?.disposableGatewayPlacementAdmission,
  );
  const runtimes = docsById(runtimeSnap.docs);
  const gateways = gatewaysSnap.docs.flatMap((doc) => {
    const root = projectGatewayDesiredRootForGateway(doc.data(), doc.id);
    if (!root) return [];
    const runtime = runtimes.get(doc.id);
    return [{
      gatewayId: doc.id,
      gatewayClass: root.gatewayClass,
      ownerUid: root.ownerUid,
      desiredStatus: root.desiredStatus,
      disposable: root.allocation?.kind === "disposable-builder",
      ready: isGatewayRuntimeDoc(runtime) &&
        runtime.gatewayId === doc.id &&
        runtime.lifecycle === "serving" &&
        runtime.heartbeat.status === "ready",
    }];
  });
  const defaultGateway = gateways.find((gateway) => gateway.gatewayId === defaultGatewayId);
  if (
    !defaultGateway ||
    defaultGateway.gatewayClass !== "shared" ||
    defaultGateway.desiredStatus !== "running"
  ) {
    throw new Error(`configured default gateway ${defaultGatewayId} is unavailable`);
  }
  return {
    defaultGatewayId,
    admission,
    users: usersSnap.docs.map((doc) => ({ uid: doc.id, data: doc.data() as Record<string, unknown> })),
    gateways,
    activeMigrations: opsSnap.docs.flatMap((doc) => activeMigration(doc) ?? []),
  };
}

async function assignInitialPlacementFirestore(
  input: FirestorePlacementPolicyInput,
  request: AssignInitialPlacementInput,
): Promise<void> {
  const shellState = resolveUserGatewayShellState(request.gateway, request.uid);
  const placement = await commitPlacementAtomic(input.db as unknown as PlacementFirestore, {
    uid: request.uid,
    slug: request.builderSlug,
    gatewayId: request.gatewayId,
    source: "repair",
    now: input.now(),
    requireDurableGateway: true,
    mirrorPatch: {
      "provisioning.openclaw.gatewayId": request.gatewayId,
      "provisioning.openclaw.gatewayProfile": shellState.gatewayProfile,
      "provisioning.openclaw.shellsEnabled": shellState.shellsEnabled,
    },
  });
  if (placement.kind !== "assigned") {
    const reason = placement.kind === "rejected" ? placement.reason : placement.kind;
    throw new Error(`initial placement onto ${request.gatewayId} failed: ${reason}`);
  }
}

async function enqueuePlacementMigration(
  input: FirestorePlacementPolicyInput,
  request: EnqueuePlacementMigrationInput,
): Promise<string> {
  const ref = input.db.collection(GLM_OPERATIONS_COLLECTION).doc();
  const now = input.now();
  await ref.set({
    kind: "migrate-customer",
    status: "pending",
    createdBy: PLACEMENT_POLICY_ACTOR,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    input: {
      uid: request.uid,
      builderSlug: request.builderSlug,
      fromGatewayId: request.fromGatewayId,
      toGatewayId: request.toGatewayId,
      source: request.source,
    },
    steps: [],
    gatewayId: request.toGatewayId,
    inputUid: request.uid,
  });
  return ref.id;
}

async function retireOwnedGatewayFirestore(
  input: FirestorePlacementPolicyInput,
  request: RetireOwnedGatewayInput,
): Promise<boolean> {
  const operationId = `placement-retire-${request.uid}-${request.gatewayId}`;
  const now = input.now();
  try {
    await claimGatewayRetirementAtomic({
      db: input.db,
      gatewayId: request.gatewayId,
      operationId,
      operation: {
        kind: "retire-gateway",
        status: "pending",
        createdBy: PLACEMENT_POLICY_ACTOR,
        createdAt: now,
        startedAt: null,
        completedAt: null,
        input: {
          gatewayId: request.gatewayId,
          uid: request.uid,
          builderSlug: request.builderSlug,
          reason: "dedicated-entitlement-ended",
        },
        steps: [],
        gatewayId: request.gatewayId,
      },
      now,
      updatedBy: PLACEMENT_POLICY_ACTOR,
      claimGuard: ({ root }) => {
        const record = root as unknown as Record<string, unknown>;
        if (record.ownerUid !== request.uid || record.gatewayClass === "shared") {
          throw new GatewayRetirementConflictError(
            `gateway ${request.gatewayId} is no longer owned by ${request.uid}`,
          );
        }
      },
    });
    return true;
  } catch (error) {
    if (!(error instanceof GatewayRetirementConflictError)) throw error;
    input.log(`[placement-policy] retirement blocked for ${request.gatewayId}: ${error.message}`);
    return false;
  }
}

export function createFirestorePlacementPolicyReconcilerDeps(
  input: FirestorePlacementPolicyInput,
): PlacementPolicyReconcilerDeps {
  return {
    now: input.now,
    log: input.log,
    readSnapshot: () => readPlacementPolicySnapshot(input.db),
    assignInitialPlacement: (request) => assignInitialPlacementFirestore(input, request),
    enqueueMigration: (request) => enqueuePlacementMigration(input, request),
    retireOwnedGateway: (request) => retireOwnedGatewayFirestore(input, request),
  };
}

export function startPlacementPolicyReconciler(
  deps: PlacementPolicyReconcilerDeps,
  intervalMs = PLACEMENT_POLICY_RECONCILE_MS_DEFAULT,
): () => void {
  if (intervalMs <= 0) return () => undefined;
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await reconcilePlacementPolicyOnce(deps);
    } catch (error) {
      deps.log(`[placement-policy] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
