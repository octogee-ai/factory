import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { resolveBuilderTier } from "@octogee/shared/types/billing";
import { BUILDER_TIERS } from "@octogee/shared/types/billing-tiers";

export type BuilderRuntimeDemandCause =
  | "run-start"
  | "chat"
  | "scheduled"
  | "manual";

export type BuilderActivationLeaseResult = {
  statusCode: number;
  body: Record<string, unknown>;
};

export interface BuilderRuntimeDemandRequest {
  db: Firestore;
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

function activeActivityLease(lease: Record<string, unknown>, gatewayId: string): boolean {
  return lease.status === "active" && nonEmptyString(lease.leaseId) !== null &&
    positiveInteger(lease.generation) !== null && lease.targetGatewayId === gatewayId &&
    lease.returnRequestedAt === undefined;
}

function servingActivityAssignment(assigned: Record<string, unknown> | undefined, uid: string, gatewayId: string): boolean {
  return assigned?.uid === uid && assigned.gatewayId === gatewayId && assigned.state === "serving" &&
    Number.isSafeInteger(assigned.epoch) && (assigned.epoch as number) >= 0;
}

export async function recordBuilderRuntimeActivity(input: {
  db: Firestore;
  uid: string;
  gatewayId: string;
  now?: number;
}): Promise<boolean> {
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now) || now <= 0) throw new Error("invalid runtime activity time");
  const userRef = input.db.doc(`users/${input.uid}`);
  const assignmentRef = input.db.doc(`gateways/${input.gatewayId}/assignments/${input.uid}`);
  return input.db.runTransaction(async transaction => {
    const [user, assignment] = await Promise.all([transaction.get(userRef), transaction.get(assignmentRef)]);
    const data = user.data();
    const lease = data ? userLease(data) : null;
    const assigned = assignment.data();
    if (!data || !lease || !activeActivityLease(lease, input.gatewayId) ||
      userGatewayId(data) !== input.gatewayId ||
      !servingActivityAssignment(assigned, input.uid, input.gatewayId) ||
      "result" in activationDemandEligibility(data, now)) return false;
    const previous = typeof lease.lastActiveAt === "number" ? lease.lastActiveAt : 0;
    if (now - previous >= 60_000) transaction.update(userRef, {
      "provisioning.openclaw.activationLease.lastActiveAt": now,
    });
    return true;
  });
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

function userGatewayId(userData: Record<string, unknown>): string | null {
  const provisioning = record(userData.provisioning);
  const openclaw = record(provisioning?.openclaw);
  return nonEmptyString(openclaw?.gatewayId);
}

function userLease(userData: Record<string, unknown>): Record<string, unknown> | null {
  const provisioning = record(userData.provisioning);
  const openclaw = record(provisioning?.openclaw);
  return record(openclaw?.activationLease);
}

function builderSlug(userData: Record<string, unknown>): string | null {
  const provisioning = record(userData.provisioning);
  const openclaw = record(provisioning?.openclaw);
  return nonEmptyString(openclaw?.slug) ?? nonEmptyString(userData.username);
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
  userData: Record<string, unknown>;
  assignmentData: Record<string, unknown> | undefined;
}): boolean {
  const assignment = input.assignmentData;
  return userGatewayId(input.userData) === input.reportingGatewayId &&
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
      entitlementTier: keyof typeof BUILDER_TIERS;
      sizingTier: string;
      slug: string;
    };

function activationDemandEligibility(
  userData: Record<string, unknown>,
  now: number,
): ActivationDemandEligibility {
  if (!accountAllowsInteractiveAccess(userData)) {
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
  const entitlementTier = resolveBuilderTier(userData, new Date(now));
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
  const sizingTier = BUILDER_TIERS[entitlementTier].instance;
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
  const slug = builderSlug(userData);
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
  lease: Record<string, unknown> | null;
  eventKey: string;
  cause: BuilderRuntimeDemandCause;
  observedAt: number;
  sourceGatewayId: string;
  sourceAssignmentEpoch: number;
}): Record<string, unknown> | null {
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
  lease: Record<string, unknown> | null,
  input: {
    eventKey: string;
    cause: BuilderRuntimeDemandCause;
    observedAt: number;
    createdBy: string;
    sourceGatewayId: string;
    sourceAssignmentEpoch: number;
  },
): Record<string, unknown> | null {
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
  const userRef = input.db.doc(`users/${input.uid}`);
  const assignmentRef = input.db.doc(
    `gateways/${reportingGatewayId}/assignments/${input.uid}`,
  );

  return input.db.runTransaction(async (transaction) => {
    const [userSnapshot, assignmentSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(assignmentRef),
    ]);
    if (!userSnapshot.exists) {
      return {
        statusCode: 404,
        body: { code: "user-not-found", error: "user not found", uid: input.uid },
      };
    }
    const userData = userSnapshot.data() as Record<string, unknown>;
    const assignmentData = assignmentSnapshot.exists
      ? assignmentSnapshot.data() as Record<string, unknown>
      : undefined;
    if (!sourceFenceMatches({
      uid: input.uid,
      reportingGatewayId,
      assignmentEpoch,
      userData,
      assignmentData,
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
    const eligibility = activationDemandEligibility(
      userData,
      input.now ?? Date.now(),
    );
    if ("result" in eligibility) return eligibility.result;
    const { entitlementTier, sizingTier, slug } = eligibility;
    const existing = userLease(userData);
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
      transaction.update(userRef, {
        "provisioning.openclaw.activationLease": returningLease,
      });
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
      transaction.update(userRef, {
        "provisioning.openclaw.activationLease": adoptedLease,
      });
      return demandBody({
        lease: adoptedLease,
        status: String(adoptedLease.status),
        sizingTier,
        adopted: true,
      });
    }
    const generation = (positiveInteger(existing?.generation) ?? 0) + 1;
    const next = {
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
      entitlementTier,
      sizingTier,
    };
    transaction.update(userRef, {
      "provisioning.openclaw.activationLease": next,
    });
    return demandBody({ lease: next, status: "requested", sizingTier });
  });
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
