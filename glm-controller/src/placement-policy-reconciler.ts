import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";

import {
  GatewayRetirementConflictError,
  claimGatewayRetirementAtomic,
} from "@octogee/core/gateway-retirement-claim";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
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
import type { SizingTier } from "@octogee/shared/types/sizing";
import type { BuilderTierName } from "@octogee/shared/types/billing-tiers";
import {
  advanceActivationLeaseFirestore,
  allocateDisposableGatewayFirestore,
} from "./disposable-gateway-lifecycle.js";

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

export interface PlacementPolicySnapshot {
  defaultGatewayId: string;
  users: PlacementPolicyUser[];
  gateways: ContinuousPlacementOwnedGateway[];
  activeMigrations: PlacementPolicyMigration[];
}

export interface EnqueuePlacementMigrationInput {
  uid: string;
  builderSlug: string;
  fromGatewayId: string;
  toGatewayId: string;
  source: "continuous-placement-policy" | "builder-activation-lease";
  operationId?: string;
}

export interface AllocateDisposableGatewayInput {
  uid: string;
  builderSlug: string;
  leaseId: string;
  generation: number;
  sourceGatewayId: string;
  sourceAssignmentEpoch: number;
  entitlementTier: BuilderTierName;
  sizingTier: SizingTier;
}

export interface AdvanceActivationLeaseInput {
  uid: string;
  leaseId: string;
  generation: number;
  fromStatus: "provisioning" | "activating";
  toStatus: "activating" | "active";
  operationId?: string;
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
  allocateDisposableGateway(input: AllocateDisposableGatewayInput): Promise<string>;
  advanceActivationLease(input: AdvanceActivationLeaseInput): Promise<void>;
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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

interface BuilderActivationLease {
  raw: Record<string, unknown>;
  leaseId: string;
  generation: number;
  status: string;
  targetGatewayId: string | null;
}

function builderActivationLease(data: Record<string, unknown>): BuilderActivationLease | null {
  const provisioning = record(data.provisioning);
  const openclaw = record(provisioning?.openclaw);
  const raw = record(openclaw?.activationLease);
  const leaseId = nonEmptyString(raw?.leaseId);
  const generation = positiveInteger(raw?.generation);
  const status = nonEmptyString(raw?.status);
  if (!raw || !leaseId || !generation || !status) return null;
  return {
    raw,
    leaseId,
    generation,
    status,
    targetGatewayId: nonEmptyString(raw.targetGatewayId),
  };
}

interface PlacementPolicyReconcileContext {
  deps: PlacementPolicyReconcilerDeps;
  state: PlacementPolicySnapshot;
  gateways: Map<string, ContinuousPlacementOwnedGateway>;
  migrations: Map<string, PlacementPolicyMigration>;
  result: PlacementPolicyReconcileResult;
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

function disposableTargetMatchesLease(
  gateway: ContinuousPlacementOwnedGateway,
  user: PlacementPolicyUser,
  lease: BuilderActivationLease,
): boolean {
  const allocation = gateway.allocation;
  return gateway.gatewayClass === "operator" &&
    gateway.ownerUid === user.uid &&
    gateway.desiredStatus === "running" &&
    gateway.disposable === true &&
    allocation?.kind === "disposable-builder" &&
    allocation.claimedByUid === user.uid &&
    allocation.leaseId === lease.leaseId &&
    allocation.generation === lease.generation;
}

async function reconcileRequestedActivation(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  lease: BuilderActivationLease,
): Promise<void> {
  const sourceGatewayId = nonEmptyString(lease.raw.sourceGatewayId);
  const sourceAssignmentEpoch = Number.isSafeInteger(lease.raw.sourceAssignmentEpoch)
    ? lease.raw.sourceAssignmentEpoch as number
    : null;
  const entitlementTier = nonEmptyString(lease.raw.entitlementTier) as BuilderTierName | null;
  const sizingTier = nonEmptyString(lease.raw.sizingTier) as SizingTier | null;
  if (
    !sourceGatewayId ||
    sourceAssignmentEpoch === null ||
    !entitlementTier ||
    !sizingTier
  ) {
    context.result.blocked += 1;
    return;
  }
  await context.deps.allocateDisposableGateway({
    uid: user.uid,
    builderSlug,
    leaseId: lease.leaseId,
    generation: lease.generation,
    sourceGatewayId,
    sourceAssignmentEpoch,
    entitlementTier,
    sizingTier,
  });
}

async function reconcileProvisioningActivation(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  current: string | null,
  lease: BuilderActivationLease,
): Promise<void> {
  const targetGatewayId = lease.targetGatewayId;
  const target = targetGatewayId ? context.gateways.get(targetGatewayId) : null;
  if (!target || !disposableTargetMatchesLease(target, user, lease)) {
    context.result.blocked += 1;
    return;
  }
  if (current === targetGatewayId) {
    await context.deps.advanceActivationLease({
      uid: user.uid,
      leaseId: lease.leaseId,
      generation: lease.generation,
      fromStatus: "provisioning",
      toStatus: "active",
    });
    return;
  }
  if (!target.ready) return;
  const active = context.migrations.get(user.uid);
  if (active) {
    if (active.toGatewayId !== targetGatewayId) {
      context.result.blocked += 1;
      return;
    }
    context.result.adopted += 1;
    await context.deps.advanceActivationLease({
      uid: user.uid,
      leaseId: lease.leaseId,
      generation: lease.generation,
      fromStatus: "provisioning",
      toStatus: "activating",
      operationId: active.id,
    });
    return;
  }
  const operationId = await context.deps.enqueueMigration({
    uid: user.uid,
    builderSlug,
    fromGatewayId: current ?? context.state.defaultGatewayId,
    toGatewayId: targetGatewayId!,
    source: "builder-activation-lease",
    operationId: `builder-activate-${targetGatewayId}`,
  });
  context.result.enqueued += 1;
  await context.deps.advanceActivationLease({
    uid: user.uid,
    leaseId: lease.leaseId,
    generation: lease.generation,
    fromStatus: "provisioning",
    toStatus: "activating",
    operationId,
  });
}

async function reconcileActivatingLease(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  current: string | null,
  lease: BuilderActivationLease,
): Promise<void> {
  if (current !== lease.targetGatewayId) return;
  await context.deps.advanceActivationLease({
    uid: user.uid,
    leaseId: lease.leaseId,
    generation: lease.generation,
    fromStatus: "activating",
    toStatus: "active",
  });
}

async function reconcileActivationLease(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  current: string | null,
): Promise<boolean> {
  const lease = builderActivationLease(user.data);
  if (!lease) return false;
  if (lease.status === "requested") {
    await reconcileRequestedActivation(context, user, builderSlug, lease);
    return true;
  }
  if (lease.status === "provisioning") {
    await reconcileProvisioningActivation(context, user, builderSlug, current, lease);
    return true;
  }
  if (lease.status === "activating") {
    await reconcileActivatingLease(context, user, current, lease);
    return true;
  }
  if (lease.status === "active" && lease.targetGatewayId === current) return true;
  return false;
}

async function reconcileEligibleBuilder(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
): Promise<void> {
  const current = currentGatewayId(user.data);
  if (await reconcileActivationLease(context, user, builderSlug, current)) return;
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
  const gateways = new Map(state.gateways.map((item) => [item.gatewayId, item]));
  const migrations = new Map(state.activeMigrations.map((item) => [item.uid, item]));
  const result: PlacementPolicyReconcileResult = {
    assigned: 0,
    enqueued: 0,
    adopted: 0,
    retired: 0,
    blocked: 0,
  };

  const context = { deps, state, gateways, migrations, result };
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

interface FirestorePlacementPolicyInput {
  db: Firestore;
  namespace: string;
  now(): number;
  log(message: string): void;
  ensureAuthSecret(input: { namespace: string; gatewayId: string }): Promise<unknown>;
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
      allocation: root.allocation ?? null,
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
  const ref = request.operationId
    ? input.db.collection(GLM_OPERATIONS_COLLECTION).doc(request.operationId)
    : input.db.collection(GLM_OPERATIONS_COLLECTION).doc();
  const now = input.now();
  const operation = {
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
  };
  if (!request.operationId) {
    await ref.set(operation);
    return ref.id;
  }
  await input.db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists) {
      const data = existing.data() as Record<string, unknown>;
      const operationInput = record(data.input);
      if (
        data.kind !== "migrate-customer" ||
        operationInput?.uid !== request.uid ||
        operationInput.fromGatewayId !== request.fromGatewayId ||
        operationInput.toGatewayId !== request.toGatewayId ||
        operationInput.source !== request.source
      ) {
        throw new Error(`migration operation ${ref.id} does not match activation demand`);
      }
      if (
        data.status !== "pending" &&
        data.status !== "running" &&
        data.status !== "succeeded"
      ) {
        throw new Error(`migration operation ${ref.id} ended with status ${String(data.status)}`);
      }
      return;
    }
    transaction.create(ref, operation);
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
    allocateDisposableGateway: (request) => allocateDisposableGatewayFirestore(input, request),
    advanceActivationLease: (request) => advanceActivationLeaseFirestore(input, request),
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
