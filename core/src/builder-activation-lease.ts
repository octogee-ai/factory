import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { resolveBuilderTier, type TierResolvable } from "@octogee/shared/types/billing";
import type { BuilderActivationLease, BuilderRecord } from "./platform-state/builders.js";
import { isolatedSizingTier, type GatewaySizingProfile } from "./platform-state/config.js";
import type { GatewayAssignment } from "./platform-state/gateways.js";
import type { PlatformStateStore, Stored } from "./platform-state/store.js";

export type BuilderRuntimeDemandCause =
  | "run-start"
  | "chat"
  | "scheduled"
  | "manual";

export type BuilderActivationLeaseResult = {
  statusCode: number;
  body: Record<string, unknown>;
};

export type BuilderTierReader = (uid: string, now: number) => Promise<string | null>;

export function firestoreBuilderTierReader(db: Pick<Firestore, "doc">): BuilderTierReader {
  return async (uid, now) => {
    const snapshot = await db.doc(`users/${uid}`).get();
    return snapshot.exists ? resolveBuilderTier(snapshot.data() as TierResolvable, new Date(now)) : null;
  };
}

const BUILDER_TIER_READ_ATTEMPTS = 3;

export class BuilderTierChangedError extends Error {
  constructor(readonly uid: string) {
    super(`Builder ${uid} changed while its tier was read`);
    this.name = "BuilderTierChangedError";
  }
}

export interface CurrentBuilderTier {
  readonly tier: string | null;
  readonly profile: GatewaySizingProfile | null;
  readonly assertCurrent: (builder: Stored<BuilderRecord> | null) => void;
}

export async function withCurrentBuilderTier<T>(
  input: { store: PlatformStateStore; readBuilderTier: BuilderTierReader; uid: string; now: number },
  run: (current: CurrentBuilderTier) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const revision = (await input.store.builders.records.get(input.uid))?.revision ?? null;
    const tier = await input.readBuilderTier(input.uid, input.now);
    const profile = tier === null ? null : await input.store.config.orchestrator.getSizingProfile(tier);
    const assertCurrent = (builder: Stored<BuilderRecord> | null): void => {
      if ((builder?.revision ?? null) !== revision) throw new BuilderTierChangedError(input.uid);
    };
    try {
      return await run({ tier, profile, assertCurrent });
    } catch (error) {
      if (!(error instanceof BuilderTierChangedError) || attempt === BUILDER_TIER_READ_ATTEMPTS) throw error;
    }
  }
}

export interface BuilderRuntimeDemandRequest {
  store: PlatformStateStore;
  readBuilderTier: BuilderTierReader;
  uid: string;
  reportingGatewayId?: string;
  assignmentEpoch?: number;
  eventKey?: string;
  cause?: BuilderRuntimeDemandCause;
  observedAt?: number;
  createdBy: string;
  now?: number;
  leaseIdFactory?: () => string;
}

function activeActivityLease(lease: BuilderActivationLease, gatewayId: string): boolean {
  return lease.status === "active" && nonEmptyString(lease.leaseId) !== null &&
    positiveInteger(lease.generation) !== null && lease.targetGatewayId === gatewayId &&
    lease.returnRequestedAt === undefined;
}

function servingActivityAssignment(assigned: GatewayAssignment | null, uid: string, gatewayId: string): boolean {
  return assigned?.uid === uid && assigned.gatewayId === gatewayId && assigned.state === "serving" &&
    Number.isSafeInteger(assigned.epoch) && assigned.epoch >= 0;
}

export async function recordBuilderRuntimeActivity(input: {
  store: PlatformStateStore;
  readBuilderTier: BuilderTierReader;
  uid: string;
  gatewayId: string;
  now?: number;
}): Promise<boolean> {
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now) || now <= 0) throw new Error("invalid runtime activity time");
  const tierRead = { store: input.store, readBuilderTier: input.readBuilderTier, uid: input.uid, now };
  return withCurrentBuilderTier(tierRead, ({ tier: entitlementTier, profile, assertCurrent }) => input.store.transaction({ label: "builder-activation-lease.activity" }, async (transaction) => {
    const [builder, assignment] = await Promise.all([
      transaction.builders.records.get(input.uid),
      transaction.gateways.assignments.get(input.gatewayId, input.uid),
    ]);
    assertCurrent(builder);
    const lease = builder?.activationLease ?? null;
    if (!builder || !lease || !activeActivityLease(lease, input.gatewayId) ||
      builder.gateway?.gatewayId !== input.gatewayId ||
      !servingActivityAssignment(assignment, input.uid, input.gatewayId) ||
      "result" in activationDemandEligibility(builder, entitlementTier, profile)) return false;
    const previous = typeof lease.lastActiveAt === "number" ? lease.lastActiveAt : 0;
    if (now - previous >= 60_000) {
      await transaction.builders.records.patchActivationLease(input.uid, { lastActiveAt: now }, {
        leaseId: lease.leaseId,
        generation: lease.generation,
        status: ["active"],
      });
    }
    return true;
  }));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function invalidRequest(input: BuilderRuntimeDemandRequest): BuilderActivationLeaseResult | null {
  if (
    !nonEmptyString(input.reportingGatewayId) ||
    !Number.isSafeInteger(input.assignmentEpoch) ||
    (input.assignmentEpoch as number) < 0 ||
    !nonEmptyString(input.eventKey) ||
    !input.cause ||
    !Number.isFinite(input.observedAt)
  ) {
    return {
      statusCode: 400,
      body: {
        code: "builder-runtime-demand-invalid",
        error: "runtime demand requires a source gateway, assignment epoch, event key, cause, and observation time",
      },
    };
  }
  return null;
}

function sourceFenceMatches(input: {
  uid: string;
  reportingGatewayId: string;
  assignmentEpoch: number;
  builder: BuilderRecord;
  assignment: GatewayAssignment | null;
}): boolean {
  const assignment = input.assignment;
  return input.builder.gateway?.gatewayId === input.reportingGatewayId &&
    assignment?.uid === input.uid &&
    assignment.gatewayId === input.reportingGatewayId &&
    assignment.state === "serving" &&
    assignment.epoch === input.assignmentEpoch;
}

function existingLeaseCanAdopt(lease: Record<string, unknown> | null): boolean {
  if (!lease) return false;
  return nonEmptyString(lease.leaseId) !== null &&
    positiveInteger(lease.generation) !== null &&
    (
      lease.status === "requested" ||
      lease.status === "provisioning" ||
      lease.status === "activating" ||
      lease.status === "active"
    );
}

function demandBody(input: {
  lease: Record<string, unknown>;
  status: string;
  sizingTier: string;
  adopted?: boolean;
  pending?: boolean;
}): BuilderActivationLeaseResult {
  return {
    statusCode: 202,
    body: {
      status: input.status,
      leaseId: input.lease.leaseId,
      generation: input.lease.generation,
      sizingTier: input.sizingTier,
      ...(input.adopted ? { adopted: true } : {}),
      ...(input.pending ? { pending: true } : {}),
    },
  };
}

function parkedDuplicateBody(
  lease: Record<string, unknown>,
): BuilderActivationLeaseResult | null {
  if (
    lease.status !== "parked" ||
    !nonEmptyString(lease.leaseId) ||
    !positiveInteger(lease.generation)
  ) {
    return null;
  }
  return {
    statusCode: 200,
    body: {
      status: "parked",
      leaseId: lease.leaseId,
      generation: lease.generation,
      duplicate: true,
    },
  };
}

type ActivationDemandEligibility =
  | { result: BuilderActivationLeaseResult }
  | {
      entitlementTier: string;
      sizingTier: string;
      slug: string;
    };

function activationDemandEligibility(
  builder: BuilderRecord,
  entitlementTier: string | null,
  profile: GatewaySizingProfile | null,
): ActivationDemandEligibility {
  if (!accountAllowsInteractiveAccess({ accountLifecycle: builder.accountLifecycle ?? undefined })) {
    return {
      result: {
        statusCode: 403,
        body: {
          code: "builder-runtime-not-interactive",
          error: "account does not allow interactive runtime access",
        },
      },
    };
  }
  if (!entitlementTier) {
    return {
      result: {
        statusCode: 403,
        body: {
          code: "builder-runtime-not-entitled",
          error: "Builder runtime entitlement is required",
        },
      },
    };
  }
  const sizingTier = isolatedSizingTier(profile);
  if (!sizingTier) {
    return {
      result: {
        statusCode: 409,
        body: {
          code: "builder-runtime-manual-size-required",
          error: "Builder entitlement requires an explicit operator size",
          entitlementTier,
        },
      },
    };
  }
  const slug = nonEmptyString(builder.slug);
  if (!slug) {
    return {
      result: {
        statusCode: 409,
        body: {
          code: "builder-runtime-slug-missing",
          error: "Builder runtime identity is missing a slug",
        },
      },
    };
  }
  return { entitlementTier, sizingTier, slug };
}

function parkedDuplicateForEvent(
  lease: Record<string, unknown> | null,
  eventKey: string,
): BuilderActivationLeaseResult | null {
  if (!lease) return null;
  if (lease.eventKey !== eventKey && lease.lastEventKey !== eventKey) return null;
  return parkedDuplicateBody(lease);
}

function returningLeaseWithPendingDemand(input: {
  lease: BuilderActivationLease | null;
  eventKey: string;
  cause: BuilderRuntimeDemandCause;
  observedAt: number;
  sourceGatewayId: string;
  sourceAssignmentEpoch: number;
}): BuilderActivationLease | null {
  const { lease } = input;
  if (
    lease?.status !== "returning" ||
    !nonEmptyString(lease.leaseId) ||
    !positiveInteger(lease.generation)
  ) {
    return null;
  }
  const priorPending = record(lease.pendingDemand);
  const priorObservedAt = typeof priorPending?.observedAt === "number"
    ? priorPending.observedAt
    : -1;
  const pendingDemand = priorObservedAt > input.observedAt
    ? priorPending
    : {
        eventKey: input.eventKey,
        cause: input.cause,
        observedAt: input.observedAt,
        sourceGatewayId: input.sourceGatewayId,
        sourceAssignmentEpoch: input.sourceAssignmentEpoch,
      };
  return { ...lease, pendingDemand };
}

function adoptedActivationLease(
  lease: BuilderActivationLease | null,
  input: {
    eventKey: string;
    cause: BuilderRuntimeDemandCause;
    observedAt: number;
    createdBy: string;
    sourceGatewayId: string;
    sourceAssignmentEpoch: number;
  },
): BuilderActivationLease | null {
  if (!existingLeaseCanAdopt(lease)) return null;
  const targetlessRequested =
    lease!.status === "requested" && lease!.targetGatewayId === undefined;
  return {
    ...lease!,
    status: lease!.status,
    lastActiveAt: Math.max(
      typeof lease?.lastActiveAt === "number" ? lease.lastActiveAt : 0,
      input.observedAt,
    ),
    lastEventKey: input.eventKey,
    ...(targetlessRequested
      ? {
          cause: input.cause,
          eventKey: input.eventKey,
          requestedAt: input.observedAt,
          requestedBy: input.createdBy,
          sourceGatewayId: input.sourceGatewayId,
          sourceAssignmentEpoch: input.sourceAssignmentEpoch,
        }
      : {}),
  };
}

export async function requestBuilderActivationLease(
  input: BuilderRuntimeDemandRequest,
): Promise<BuilderActivationLeaseResult> {
  const invalid = invalidRequest(input);
  if (invalid) return invalid;
  const reportingGatewayId = input.reportingGatewayId!;
  const assignmentEpoch = input.assignmentEpoch!;
  const eventKey = input.eventKey!;
  const cause = input.cause!;
  const observedAt = input.observedAt!;
  const tierRead = { store: input.store, readBuilderTier: input.readBuilderTier, uid: input.uid, now: input.now ?? Date.now() };

  return withCurrentBuilderTier(tierRead, ({ tier: entitlementTier, profile, assertCurrent }) => input.store.transaction({ label: "builder-activation-lease.request" }, async (transaction) => {
    const [builder, assignment] = await Promise.all([
      transaction.builders.records.get(input.uid),
      transaction.gateways.assignments.get(reportingGatewayId, input.uid),
    ]);
    assertCurrent(builder);
    if (!builder) {
      return {
        statusCode: 404,
        body: { code: "user-not-found", error: "user not found", uid: input.uid },
      };
    }
    if (!sourceFenceMatches({
      uid: input.uid,
      reportingGatewayId,
      assignmentEpoch,
      builder,
      assignment,
    })) {
      return {
        statusCode: 409,
        body: {
          code: "builder-runtime-assignment-stale",
          error: "runtime demand did not originate from the serving assignment epoch",
          reportingGatewayId,
          assignmentEpoch,
        },
      };
    }
    if (builder.fences.computerRecovery !== undefined) {
      return {
        statusCode: 409,
        body: { code: "builder-computer-recovery-in-progress", error: "computer recovery is in progress" },
      };
    }
    const eligibility = activationDemandEligibility(builder, entitlementTier, profile);
    if ("result" in eligibility) return eligibility.result;
    const { sizingTier, slug } = eligibility;
    const existing = builder.activationLease;
    const leaseFence = { leaseId: existing?.leaseId ?? null, generation: existing?.generation ?? null };
    const duplicate = parkedDuplicateForEvent(existing, eventKey);
    if (duplicate) return duplicate;
    const returningLease = returningLeaseWithPendingDemand({
      lease: existing,
      eventKey,
      cause,
      observedAt,
      sourceGatewayId: reportingGatewayId,
      sourceAssignmentEpoch: assignmentEpoch,
    });
    if (returningLease) {
      await transaction.builders.records.setActivationLease(input.uid, returningLease, leaseFence);
      return demandBody({
        lease: returningLease,
        status: "returning",
        sizingTier,
        pending: true,
      });
    }
    const adoptedLease = adoptedActivationLease(existing, {
      eventKey,
      cause,
      observedAt,
      createdBy: input.createdBy,
      sourceGatewayId: reportingGatewayId,
      sourceAssignmentEpoch: assignmentEpoch,
    });
    if (adoptedLease) {
      await transaction.builders.records.setActivationLease(input.uid, adoptedLease, leaseFence);
      return demandBody({
        lease: adoptedLease,
        status: String(adoptedLease.status),
        sizingTier,
        adopted: true,
      });
    }
    const generation = (positiveInteger(existing?.generation) ?? 0) + 1;
    const next: BuilderActivationLease = {
      leaseId: (input.leaseIdFactory ?? randomUUID)(),
      generation,
      status: "requested",
      cause,
      eventKey,
      requestedAt: observedAt,
      lastActiveAt: observedAt,
      requestedBy: input.createdBy,
      builderSlug: slug,
      sourceGatewayId: reportingGatewayId,
      sourceAssignmentEpoch: assignmentEpoch,
      entitlementTier: eligibility.entitlementTier,
      sizingTier,
    };
    await transaction.builders.records.setActivationLease(input.uid, next, leaseFence);
    return demandBody({ lease: next, status: "requested", sizingTier });
  }));
}

function runtimeOperationSuffix(gatewayId: string, generation: number): string {
  if (gatewayId.length === 0) throw new Error("Builder runtime operation needs a gateway id");
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error(`Builder runtime operation needs a positive generation, got ${generation}`);
  }
  return `${gatewayId}-g${generation}`;
}

export function builderActivateOperationId(gatewayId: string, generation: number): string {
  return `builder-activate-${runtimeOperationSuffix(gatewayId, generation)}`;
}

export function builderReturnOperationId(gatewayId: string, generation: number): string {
  return `builder-return-${runtimeOperationSuffix(gatewayId, generation)}`;
}

export function builderRecoverOperationId(gatewayId: string, generation: number): string {
  return `builder-recover-${runtimeOperationSuffix(gatewayId, generation)}`;
}

export function placementRetireOperationId(uid: string, gatewayId: string, generation: number): string {
  if (uid.length === 0) throw new Error("placement retirement needs an owner uid");
  return `placement-retire-${uid}-${runtimeOperationSuffix(gatewayId, generation)}`;
}

function runtimeOperationIdMatches(prefix: string, operationId: unknown, gatewayId: unknown): boolean {
  if (typeof operationId !== "string" || typeof gatewayId !== "string" || gatewayId.length === 0) return false;
  const head = `${prefix}${gatewayId}-g`;
  return operationId.startsWith(head) && /^[1-9]\d*$/.test(operationId.slice(head.length));
}

export function isBuilderActivateOperationIdFor(operationId: unknown, gatewayId: unknown): boolean {
  return runtimeOperationIdMatches("builder-activate-", operationId, gatewayId);
}

export function isBuilderReturnOperationIdFor(operationId: unknown, gatewayId: unknown): boolean {
  return runtimeOperationIdMatches("builder-return-", operationId, gatewayId);
}
