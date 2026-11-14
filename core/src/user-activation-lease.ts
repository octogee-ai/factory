import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import type { UserActivationLease, PlatformUserRecord } from "./platform-state/users.js";
import { isolatedSizingTier, type GatewaySizingProfile } from "./platform-state/config.js";
import type { GatewayAssignment } from "./platform-state/gateways.js";
import type { PlatformStateStore, Stored } from "./platform-state/store.js";

export type IsolatedRuntimeDemandCause =
  | "run-start"
  | "chat"
  | "scheduled"
  | "manual";

export type UserActivationLeaseResult = {
  statusCode: number;
  body: Record<string, unknown>;
};

export type SizingKeyReader = (uid: string, now: number) => Promise<string | null>;

export function firestoreSizingKeyReader(db: Pick<Firestore, "doc">): SizingKeyReader {
  return async (uid, now) => {
    const snapshot = await db.doc(`users/${uid}`).get();
    return snapshot.exists ? userEntitlements().sizingKey(snapshot.data() ?? {}, new Date(now)) : null;
  };
}

const SIZING_KEY_READ_ATTEMPTS = 3;

export class SizingKeyChangedError extends Error {
  constructor(readonly uid: string) {
    super(`User ${uid} changed while its sizing key was read`);
    this.name = "SizingKeyChangedError";
  }
}

export interface CurrentSizingKey {
  readonly sizingKey: string | null;
  readonly profile: GatewaySizingProfile | null;
  readonly assertCurrent: (user: Stored<PlatformUserRecord> | null) => void;
}

export async function withCurrentSizingKey<T>(
  input: { store: PlatformStateStore; readSizingKey: SizingKeyReader; uid: string; now: number },
  run: (current: CurrentSizingKey) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const revision = (await input.store.users.records.get(input.uid))?.revision ?? null;
    const sizingKey = await input.readSizingKey(input.uid, input.now);
    const profile = sizingKey === null ? null : await input.store.config.orchestrator.getSizingProfile(sizingKey);
    const assertCurrent = (user: Stored<PlatformUserRecord> | null): void => {
      if ((user?.revision ?? null) !== revision) throw new SizingKeyChangedError(input.uid);
    };
    try {
      return await run({ sizingKey, profile, assertCurrent });
    } catch (error) {
      if (!(error instanceof SizingKeyChangedError) || attempt === SIZING_KEY_READ_ATTEMPTS) throw error;
    }
  }
}

export interface IsolatedRuntimeDemandRequest {
  store: PlatformStateStore;
  readSizingKey: SizingKeyReader;
  uid: string;
  reportingGatewayId?: string;
  assignmentEpoch?: number;
  eventKey?: string;
  cause?: IsolatedRuntimeDemandCause;
  observedAt?: number;
  createdBy: string;
  now?: number;
  leaseIdFactory?: () => string;
  refuse?: (user: PlatformUserRecord) => UserActivationLeaseResult | null;
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

function invalidRequest(input: IsolatedRuntimeDemandRequest): UserActivationLeaseResult | null {
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
  user: PlatformUserRecord;
  assignment: GatewayAssignment | null;
}): boolean {
  const assignment = input.assignment;
  return input.user.gateway?.gatewayId === input.reportingGatewayId &&
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
}): UserActivationLeaseResult {
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
): UserActivationLeaseResult | null {
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

export type ActivationDemandEligibility =
  | { result: UserActivationLeaseResult }
  | {
      sizingKey: string;
      sizingTier: string;
      slug: string;
    };

export function activationDemandEligibility(
  user: PlatformUserRecord,
  sizingKey: string | null,
  profile: GatewaySizingProfile | null,
): ActivationDemandEligibility {
  if (!accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle ?? undefined })) {
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
  if (!sizingKey) {
    return {
      result: {
        statusCode: 403,
        body: {
          code: "builder-runtime-not-entitled",
          error: "Isolated runtime entitlement is required",
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
          error: "User entitlement requires an explicit operator size",
          entitlementTier: sizingKey,
        },
      },
    };
  }
  if (profile?.isolation === "isolated" && profile.computer.runtime !== "gce-vm") {
    return {
      result: {
        statusCode: 409,
        body: {
          code: "builder-runtime-not-vm",
          error: "Self-service activation needs a VM sizing profile; an operator gives an isolated gateway that runs as a pod",
          entitlementTier: sizingKey,
        },
      },
    };
  }
  const slug = nonEmptyString(user.slug);
  if (!slug) {
    return {
      result: {
        statusCode: 409,
        body: {
          code: "builder-runtime-slug-missing",
          error: "Isolated runtime identity is missing a slug",
        },
      },
    };
  }
  return { sizingKey, sizingTier, slug };
}

function parkedDuplicateForEvent(
  lease: Record<string, unknown> | null,
  eventKey: string,
): UserActivationLeaseResult | null {
  if (!lease) return null;
  if (lease.eventKey !== eventKey && lease.lastEventKey !== eventKey) return null;
  return parkedDuplicateBody(lease);
}

function returningLeaseWithPendingDemand(input: {
  lease: UserActivationLease | null;
  eventKey: string;
  cause: IsolatedRuntimeDemandCause;
  observedAt: number;
  sourceGatewayId: string;
  sourceAssignmentEpoch: number;
}): UserActivationLease | null {
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
  lease: UserActivationLease | null,
  input: {
    eventKey: string;
    cause: IsolatedRuntimeDemandCause;
    observedAt: number;
    createdBy: string;
    sourceGatewayId: string;
    sourceAssignmentEpoch: number;
  },
): UserActivationLease | null {
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

type DemandUser =
  | { user: Stored<PlatformUserRecord>; refusal: null }
  | { user: null; refusal: UserActivationLeaseResult };

function demandUser(input: IsolatedRuntimeDemandRequest, user: Stored<PlatformUserRecord> | null): DemandUser {
  if (!user) {
    return {
      user: null,
      refusal: { statusCode: 404, body: { code: "user-not-found", error: "user not found", uid: input.uid } },
    };
  }
  const refusal = input.refuse?.(user) ?? null;
  return refusal ? { user: null, refusal } : { user, refusal: null };
}

export async function requestUserActivationLease(
  input: IsolatedRuntimeDemandRequest,
): Promise<UserActivationLeaseResult> {
  const invalid = invalidRequest(input);
  if (invalid) return invalid;
  const reportingGatewayId = input.reportingGatewayId!;
  const assignmentEpoch = input.assignmentEpoch!;
  const eventKey = input.eventKey!;
  const cause = input.cause!;
  const observedAt = input.observedAt!;
  const sizingKeyRead = { store: input.store, readSizingKey: input.readSizingKey, uid: input.uid, now: input.now ?? Date.now() };

  return withCurrentSizingKey(sizingKeyRead, ({ sizingKey, profile, assertCurrent }) => input.store.transaction({ label: "builder-activation-lease.request" }, async (transaction) => {
    const [read, assignment] = await Promise.all([
      transaction.users.records.get(input.uid),
      transaction.gateways.assignments.get(reportingGatewayId, input.uid),
    ]);
    assertCurrent(read);
    const { user, refusal } = demandUser(input, read);
    if (refusal) return refusal;
    if (!sourceFenceMatches({
      uid: input.uid,
      reportingGatewayId,
      assignmentEpoch,
      user,
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
    if (user.fences.computerRecovery !== undefined) {
      return {
        statusCode: 409,
        body: { code: "builder-computer-recovery-in-progress", error: "VM recovery is in progress" },
      };
    }
    const eligibility = activationDemandEligibility(user, sizingKey, profile);
    if ("result" in eligibility) return eligibility.result;
    const { sizingTier, slug } = eligibility;
    const existing = user.activationLease;
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
      await transaction.users.records.setActivationLease(input.uid, returningLease, leaseFence);
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
      await transaction.users.records.setActivationLease(input.uid, adoptedLease, leaseFence);
      return demandBody({
        lease: adoptedLease,
        status: String(adoptedLease.status),
        sizingTier,
        adopted: true,
      });
    }
    const generation = (positiveInteger(existing?.generation) ?? 0) + 1;
    const next: UserActivationLease = {
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
      entitlementTier: eligibility.sizingKey,
      sizingTier,
    };
    await transaction.users.records.setActivationLease(input.uid, next, leaseFence);
    return demandBody({ lease: next, status: "requested", sizingTier });
  }));
}

function runtimeOperationSuffix(gatewayId: string, generation: number): string {
  if (gatewayId.length === 0) throw new Error("Isolated runtime operation needs a gateway id");
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error(`Isolated runtime operation needs a positive generation, got ${generation}`);
  }
  return `${gatewayId}-g${generation}`;
}

export function builderActivateOperationId(gatewayId: string, generation: number): string {
  return `builder-activate-${runtimeOperationSuffix(gatewayId, generation)}`;
}

export function builderReturnOperationId(gatewayId: string, generation: number): string {
  return `builder-return-${runtimeOperationSuffix(gatewayId, generation)}`;
}

export function isolatedRecoverOperationId(gatewayId: string, generation: number): string {
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

export function isUserActivateOperationIdFor(operationId: unknown, gatewayId: unknown): boolean {
  return runtimeOperationIdMatches("builder-activate-", operationId, gatewayId);
}

export function isUserReturnOperationIdFor(operationId: unknown, gatewayId: unknown): boolean {
  return runtimeOperationIdMatches("builder-return-", operationId, gatewayId);
}
