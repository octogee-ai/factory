import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";

import { readGatewayArtifact } from "@octogee/core/gateway-live-release";
import {
  GatewayRetirementConflictError,
  claimGatewayRetirementAtomic,
} from "@octogee/core/gateway-retirement-claim";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { resolvePaidBuilderTier } from "@octogee/shared/types/billing";
import { BUILDER_TIERS } from "@octogee/shared/types/billing-tiers";
import { builderGatewayIdForSlug } from "@octogee/shared/types/builder-gateway-id";
import { GATEWAYS_COLLECTION } from "@octogee/shared/types/fleet-controller";
import {
  GLM_GATEWAYS_COLLECTION,
  GLM_OPERATIONS_COLLECTION,
  OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
  OPERATOR_GATEWAY_RESERVATIONS_COLLECTION,
  defaultOperatorGatewayAccess,
  operatorGatewayServiceAccountName,
  resolveUserGatewayShellState,
} from "@octogee/shared/types/glm";
import {
  GATEWAY_RELEASES_SUBCOLLECTION,
  commitPlacementAtomic,
  isGatewayRuntimeDoc,
  projectGatewayDesiredRootForGateway,
  releasePayloadHash,
  type PlacementFirestore,
} from "@octogee/shared/types/gateway-releases";
import {
  resolveContinuousBuilderPlacement,
  resolveEntitledOwnedGatewayId,
  resolveOnboardingPlacementEligibility,
  type ContinuousPlacementOwnedGateway,
} from "@octogee/shared/types/orchestrator-placement";
import { isSizingTier } from "@octogee/shared/types/sizing";
import { TRIAL_GATEWAY_CLAIMS_COLLECTION } from "@octogee/shared/types/trial-gateway";

export const PLACEMENT_POLICY_RECONCILE_MS_DEFAULT = 15_000;
const PLACEMENT_POLICY_ACTOR = "glm-controller-placement-policy";

export interface PlacementPolicyUser {
  uid: string;
  data: Record<string, unknown>;
}

export interface PlacementPolicyReservation {
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
  reservations: PlacementPolicyReservation[];
  gateways: ContinuousPlacementOwnedGateway[];
  activeMigrations: PlacementPolicyMigration[];
}

export interface EnsureOwnedGatewayInput {
  uid: string;
  builderSlug: string;
  gatewayId: string;
  kind: "trial" | "paid";
  userData: Record<string, unknown>;
  reservation: Record<string, unknown> | null;
}

export interface EnqueuePlacementMigrationInput {
  uid: string;
  builderSlug: string;
  fromGatewayId: string;
  toGatewayId: string;
  source: "continuous-placement-policy" | "operator-gateway-reservation";
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
  ensureOwnedGateway(input: EnsureOwnedGatewayInput): Promise<void>;
  enqueueMigration(input: EnqueuePlacementMigrationInput): Promise<string>;
  retireOwnedGateway(input: RetireOwnedGatewayInput): Promise<boolean>;
}

export interface PlacementPolicyReconcileResult {
  assigned: number;
  enqueued: number;
  adopted: number;
  provisioning: number;
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

function requestedPaidGateway(input: {
  uid: string;
  slug: string;
  userData: Record<string, unknown>;
  reservation: Record<string, unknown> | null;
}): string | null {
  if (resolvePaidBuilderTier(input.userData) === null || input.reservation?.status !== "requested") {
    return null;
  }
  return input.reservation.uid === input.uid && input.reservation.builderSlug === input.slug
    ? builderGatewayIdForSlug(input.slug)
    : null;
}

interface PlacementPolicyReconcileContext {
  deps: PlacementPolicyReconcilerDeps;
  state: PlacementPolicySnapshot;
  reservations: Map<string, Record<string, unknown>>;
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

async function ensureWantedOwnedGateway(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
  reservation: Record<string, unknown> | null,
  owned: { requestedPaid: string | null; entitledOwned: string | null },
): Promise<boolean> {
  const wantedOwned = owned.requestedPaid ?? owned.entitledOwned;
  if (!wantedOwned) return false;
  if (owned.requestedPaid === null && context.gateways.has(wantedOwned)) return false;
  await context.deps.ensureOwnedGateway({
    uid: user.uid,
    builderSlug,
    gatewayId: wantedOwned,
    kind: owned.requestedPaid ? "paid" : "trial",
    userData: user.data,
    reservation,
  });
  context.result.provisioning += 1;
  return true;
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

async function reconcileEligibleBuilder(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
  builderSlug: string,
): Promise<void> {
  const current = currentGatewayId(user.data);
  const reservation = context.reservations.get(user.uid) ?? null;
  const requestedPaid = requestedPaidGateway({
    uid: user.uid,
    slug: builderSlug,
    userData: user.data,
    reservation,
  });
  const entitledOwned = resolveEntitledOwnedGatewayId({
    userData: user.data,
    reservation,
    now: new Date(context.deps.now()),
  });
  if (await ensureWantedOwnedGateway(
    context,
    user,
    builderSlug,
    reservation,
    { requestedPaid, entitledOwned },
  )) return;
  const placement = resolveContinuousBuilderPlacement({
    uid: user.uid,
    userData: user.data,
    reservation,
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
  const paidTarget = reservation?.gatewayId === placement.targetGatewayId &&
    (reservation.status === "provisioning" || reservation.status === "fulfilled");
  await context.deps.enqueueMigration({
    uid: user.uid,
    builderSlug,
    fromGatewayId: current,
    toGatewayId: placement.targetGatewayId,
    source: paidTarget ? "operator-gateway-reservation" : "continuous-placement-policy",
  });
  context.result.enqueued += 1;
}

async function reconcilePlacementUser(
  context: PlacementPolicyReconcileContext,
  user: PlacementPolicyUser,
): Promise<void> {
  if (!accountAllowsInteractiveAccess(user.data)) return;
  const eligibility = resolveOnboardingPlacementEligibility(user.data);
  if (!eligibility.eligible) return;
  await reconcileEligibleBuilder(context, user, eligibility.slug);
}

export async function reconcilePlacementPolicyOnce(
  deps: PlacementPolicyReconcilerDeps,
): Promise<PlacementPolicyReconcileResult> {
  const state = await deps.readSnapshot();
  if (!state.defaultGatewayId) throw new Error("placement policy default gateway is missing");
  const reservations = new Map(state.reservations.map((item) => [item.uid, item.data]));
  const gateways = new Map(state.gateways.map((item) => [item.gatewayId, item]));
  const migrations = new Map(state.activeMigrations.map((item) => [item.uid, item]));
  const result: PlacementPolicyReconcileResult = {
    assigned: 0,
    enqueued: 0,
    adopted: 0,
    provisioning: 0,
    retired: 0,
    blocked: 0,
  };

  const context = { deps, state, reservations, gateways, migrations, result };
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
  ensureAuthSecret(gatewayId: string): Promise<void>;
  now(): number;
  log(message: string): void;
}

async function readPlacementPolicySnapshot(db: Firestore): Promise<PlacementPolicySnapshot> {
  const [configSnap, usersSnap, reservationsSnap, gatewaysSnap, runtimeSnap, opsSnap] =
    await Promise.all([
      db.doc("config/orchestrator").get(),
      db.collection("users").get(),
      db.collection(OPERATOR_GATEWAY_RESERVATIONS_COLLECTION).get(),
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
    reservations: reservationsSnap.docs.map((doc) => ({
      uid: doc.id,
      data: doc.data() as Record<string, unknown>,
    })),
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

function paidGatewayRoot(input: {
  request: EnsureOwnedGatewayInput;
  sizingTier: string;
  shellsEnabled: boolean;
  release: number;
  now: number;
}): Record<string, unknown> {
  return {
    gatewayId: input.request.gatewayId,
    createdAt: input.now,
    createdBy: PLACEMENT_POLICY_ACTOR,
    updatedAt: input.now,
    updatedBy: PLACEMENT_POLICY_ACTOR,
    latestRelease: input.release,
    desiredRelease: input.release,
    liveRelease: null,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: "operator",
    gatewayClass: "operator",
    imageProfile: "operator",
    sizingTier: input.sizingTier,
    computeClass: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: operatorGatewayServiceAccountName(input.request.gatewayId),
    serviceAccount: OPERATOR_GATEWAY_LOCKED_SERVICE_ACCOUNT,
    operatorAccess: defaultOperatorGatewayAccess(input.request.uid, input.shellsEnabled),
    ownerUid: input.request.uid,
    builderSlug: input.request.builderSlug,
    openclawOverrides: null,
    modelBrokerLimits: null,
    preemption: null,
  };
}

function assertPaidReservationUnchanged(input: {
  userExists: boolean;
  reservationExists: boolean;
  reservation: Record<string, unknown> | undefined;
  userData: Record<string, unknown> | undefined;
  request: EnsureOwnedGatewayInput;
  sizingTier: string;
}): void {
  const changed = !input.userExists ||
    !input.reservationExists ||
    input.reservation?.status !== "requested" ||
    input.reservation.uid !== input.request.uid ||
    input.reservation.builderSlug !== input.request.builderSlug ||
    input.reservation.requestedSizingTier !== input.sizingTier ||
    resolvePaidBuilderTier(input.userData ?? {}) === null;
  if (changed) throw new Error(`paid gateway reservation changed for ${input.request.uid}`);
}

function existingPaidGatewayUpdate(input: {
  data: Record<string, unknown> | undefined;
  request: EnsureOwnedGatewayInput;
  sizingTier: string;
  shellsEnabled: boolean;
  now: number;
}): Record<string, unknown> {
  const existing = projectGatewayDesiredRootForGateway(input.data, input.request.gatewayId);
  if (
    !existing ||
    existing.gatewayClass === "shared" ||
    existing.ownerUid !== input.request.uid ||
    existing.builderSlug !== input.request.builderSlug ||
    existing.desiredStatus !== "running"
  ) {
    throw new Error(
      `existing gateway ${input.request.gatewayId} cannot fulfill ${input.request.uid}`,
    );
  }
  return {
    sizingTier: input.sizingTier,
    operatorAccess: defaultOperatorGatewayAccess(input.request.uid, input.shellsEnabled),
    updatedAt: input.now,
    updatedBy: PLACEMENT_POLICY_ACTOR,
  };
}

function paidReservationStateUpdates(input: {
  request: EnsureOwnedGatewayInput;
  alreadyActive: boolean;
  now: number;
}): { reservation: Record<string, unknown>; user: Record<string, unknown> } {
  if (input.alreadyActive) {
    return {
      reservation: {
        status: "fulfilled",
        gatewayId: input.request.gatewayId,
        fulfilledAt: input.now,
        fulfilledByOperationId: PLACEMENT_POLICY_ACTOR,
        updatedAt: input.now,
      },
      user: {
        "operatorGatewayReservation.status": "fulfilled",
        "operatorGatewayReservation.gatewayId": input.request.gatewayId,
        "operatorGatewayReservation.fulfilledAt": input.now,
        "operatorGatewayReservation.fulfilledByOperationId": PLACEMENT_POLICY_ACTOR,
        "operatorGatewayReservation.updatedAt": input.now,
      },
    };
  }
  return {
    reservation: {
      status: "provisioning",
      gatewayId: input.request.gatewayId,
      provisioningStartedAt: input.now,
      provisioningStartedBy: PLACEMENT_POLICY_ACTOR,
      updatedAt: input.now,
    },
    user: {
      "operatorGatewayReservation.status": "provisioning",
      "operatorGatewayReservation.gatewayId": input.request.gatewayId,
      "operatorGatewayReservation.provisioningStartedAt": input.now,
      "operatorGatewayReservation.provisioningStartedBy": PLACEMENT_POLICY_ACTOR,
      "operatorGatewayReservation.updatedAt": input.now,
    },
  };
}

async function ensurePaidOwnedGateway(
  input: FirestorePlacementPolicyInput,
  request: EnsureOwnedGatewayInput,
): Promise<void> {
  const { db } = input;
  const sizingTier = request.reservation?.requestedSizingTier;
  if (!isSizingTier(sizingTier) || request.reservation?.billingStatus !== "active") {
    throw new Error(`paid gateway reservation for ${request.uid} is not provisionable`);
  }
  const configSnap = await db.doc("config/orchestrator").get();
  const sourceGatewayId = nonEmptyString(configSnap.data()?.defaultGatewayId);
  if (!sourceGatewayId) throw new Error("configured default gateway is missing");
  const sourceRootSnap = await db.collection(GATEWAYS_COLLECTION).doc(sourceGatewayId).get();
  const sourceRoot = projectGatewayDesiredRootForGateway(sourceRootSnap.data(), sourceGatewayId);
  if (!sourceRoot || sourceRoot.gatewayClass !== "shared" || sourceRoot.desiredStatus !== "running") {
    throw new Error(`configured default gateway ${sourceGatewayId} is unavailable`);
  }
  const payload = await readGatewayArtifact(db, sourceGatewayId, sourceRoot.desiredRelease);
  if (!payload) throw new Error(`configured default gateway ${sourceGatewayId} has no release artifact`);
  await input.ensureAuthSecret(request.gatewayId);
  const tier = resolvePaidBuilderTier(request.userData);
  if (!tier) throw new Error(`paid Builder entitlement disappeared for ${request.uid}`);
  const now = input.now();
  const rootRef = db.collection(GATEWAYS_COLLECTION).doc(request.gatewayId);
  const reservationRef = db.collection(OPERATOR_GATEWAY_RESERVATIONS_COLLECTION).doc(request.uid);
  const userRef = db.collection("users").doc(request.uid);
  await db.runTransaction(async (transaction) => {
    const [rootSnap, reservationSnap, userSnap] = await Promise.all([
      transaction.get(rootRef),
      transaction.get(reservationRef),
      transaction.get(userRef),
    ]);
    const reservation = reservationSnap.data() as Record<string, unknown> | undefined;
    const userData = userSnap.data() as Record<string, unknown> | undefined;
    assertPaidReservationUnchanged({
      userExists: userSnap.exists,
      reservationExists: reservationSnap.exists,
      reservation,
      userData,
      request,
      sizingTier,
    });
    const shellsEnabled = BUILDER_TIERS[tier].builderShell;
    if (rootSnap.exists) {
      transaction.update(rootRef, existingPaidGatewayUpdate({
        data: rootSnap.data(),
        request,
        sizingTier,
        shellsEnabled,
        now,
      }));
    } else {
      transaction.set(rootRef, paidGatewayRoot({
        request,
        sizingTier,
        shellsEnabled,
        release: sourceRoot.desiredRelease,
        now,
      }));
      transaction.set(
        rootRef.collection(GATEWAY_RELEASES_SUBCOLLECTION).doc(String(sourceRoot.desiredRelease)),
        {
          gatewayId: request.gatewayId,
          release: sourceRoot.desiredRelease,
          createdAt: now,
          createdBy: PLACEMENT_POLICY_ACTOR,
          sourceRelease: null,
          note: `paid gateway copied from ${sourceGatewayId}`,
          payloadHash: releasePayloadHash(payload),
          payload,
        },
      );
    }
    const reservationState = paidReservationStateUpdates({
      request,
      alreadyActive: rootSnap.exists && currentGatewayId(userData ?? {}) === request.gatewayId,
      now,
    });
    transaction.update(reservationRef, reservationState.reservation);
    transaction.update(userRef, reservationState.user);
  });
}

async function ensureOwnedGatewayFirestore(
  input: FirestorePlacementPolicyInput,
  request: EnsureOwnedGatewayInput,
): Promise<void> {
  if (request.kind === "paid") return ensurePaidOwnedGateway(input, request);
  await input.db.collection(TRIAL_GATEWAY_CLAIMS_COLLECTION).doc(request.uid).set({
    uid: request.uid,
    slug: request.builderSlug,
    status: "waiting",
    requestedAt: input.now(),
  }, { merge: true });
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
      ...(request.source === "operator-gateway-reservation"
        ? { operatorReservationUid: request.uid }
        : {}),
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
    ensureOwnedGateway: (request) => ensureOwnedGatewayFirestore(input, request),
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
