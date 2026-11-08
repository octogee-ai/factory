import { randomUUID } from "node:crypto";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { resolveBuilderTier } from "@octogee/shared/types/billing";
import { BUILDER_TIERS } from "@octogee/shared/types/billing-tiers";
export function firestoreBuilderTierReader(db) {
    return async (uid, now) => {
        const snapshot = await db.doc(`users/${uid}`).get();
        return snapshot.exists ? resolveBuilderTier(snapshot.data(), new Date(now)) : null;
    };
}
const BUILDER_TIER_READ_ATTEMPTS = 3;
export class BuilderTierChangedError extends Error {
    uid;
    constructor(uid) {
        super(`Builder ${uid} changed while its tier was read`);
        this.uid = uid;
        this.name = "BuilderTierChangedError";
    }
}
export async function withCurrentBuilderTier(input, run) {
    for (let attempt = 1;; attempt += 1) {
        const revision = (await input.store.builders.records.get(input.uid))?.revision ?? null;
        const tier = await input.readBuilderTier(input.uid, input.now);
        const assertCurrent = (builder) => {
            if ((builder?.revision ?? null) !== revision)
                throw new BuilderTierChangedError(input.uid);
        };
        try {
            return await run({ tier, assertCurrent });
        }
        catch (error) {
            if (!(error instanceof BuilderTierChangedError) || attempt === BUILDER_TIER_READ_ATTEMPTS)
                throw error;
        }
    }
}
function activeActivityLease(lease, gatewayId) {
    return lease.status === "active" && nonEmptyString(lease.leaseId) !== null &&
        positiveInteger(lease.generation) !== null && lease.targetGatewayId === gatewayId &&
        lease.returnRequestedAt === undefined;
}
function servingActivityAssignment(assigned, uid, gatewayId) {
    return assigned?.uid === uid && assigned.gatewayId === gatewayId && assigned.state === "serving" &&
        Number.isSafeInteger(assigned.epoch) && assigned.epoch >= 0;
}
export async function recordBuilderRuntimeActivity(input) {
    const now = input.now ?? Date.now();
    if (!Number.isFinite(now) || now <= 0)
        throw new Error("invalid runtime activity time");
    const tierRead = { store: input.store, readBuilderTier: input.readBuilderTier, uid: input.uid, now };
    return withCurrentBuilderTier(tierRead, ({ tier: entitlementTier, assertCurrent }) => input.store.transaction({ label: "builder-activation-lease.activity" }, async (transaction) => {
        const [builder, assignment] = await Promise.all([
            transaction.builders.records.get(input.uid),
            transaction.gateways.assignments.get(input.gatewayId, input.uid),
        ]);
        assertCurrent(builder);
        const lease = builder?.activationLease ?? null;
        if (!builder || !lease || !activeActivityLease(lease, input.gatewayId) ||
            builder.gateway?.gatewayId !== input.gatewayId ||
            !servingActivityAssignment(assignment, input.uid, input.gatewayId) ||
            "result" in activationDemandEligibility(builder, entitlementTier))
            return false;
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
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
function positiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function invalidRequest(input) {
    if (!nonEmptyString(input.reportingGatewayId) ||
        !Number.isSafeInteger(input.assignmentEpoch) ||
        input.assignmentEpoch < 0 ||
        !nonEmptyString(input.eventKey) ||
        !input.cause ||
        !Number.isFinite(input.observedAt)) {
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
function sourceFenceMatches(input) {
    const assignment = input.assignment;
    return input.builder.gateway?.gatewayId === input.reportingGatewayId &&
        assignment?.uid === input.uid &&
        assignment.gatewayId === input.reportingGatewayId &&
        assignment.state === "serving" &&
        assignment.epoch === input.assignmentEpoch;
}
function existingLeaseCanAdopt(lease) {
    if (!lease)
        return false;
    return nonEmptyString(lease.leaseId) !== null &&
        positiveInteger(lease.generation) !== null &&
        (lease.status === "requested" ||
            lease.status === "provisioning" ||
            lease.status === "activating" ||
            lease.status === "active");
}
function demandBody(input) {
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
function parkedDuplicateBody(lease) {
    if (lease.status !== "parked" ||
        !nonEmptyString(lease.leaseId) ||
        !positiveInteger(lease.generation)) {
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
function activationDemandEligibility(builder, entitlementTier) {
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
function parkedDuplicateForEvent(lease, eventKey) {
    if (!lease)
        return null;
    if (lease.eventKey !== eventKey && lease.lastEventKey !== eventKey)
        return null;
    return parkedDuplicateBody(lease);
}
function returningLeaseWithPendingDemand(input) {
    const { lease } = input;
    if (lease?.status !== "returning" ||
        !nonEmptyString(lease.leaseId) ||
        !positiveInteger(lease.generation)) {
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
function adoptedActivationLease(lease, input) {
    if (!existingLeaseCanAdopt(lease))
        return null;
    const targetlessRequested = lease.status === "requested" && lease.targetGatewayId === undefined;
    return {
        ...lease,
        status: lease.status,
        lastActiveAt: Math.max(typeof lease?.lastActiveAt === "number" ? lease.lastActiveAt : 0, input.observedAt),
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
export async function requestBuilderActivationLease(input) {
    const invalid = invalidRequest(input);
    if (invalid)
        return invalid;
    const reportingGatewayId = input.reportingGatewayId;
    const assignmentEpoch = input.assignmentEpoch;
    const eventKey = input.eventKey;
    const cause = input.cause;
    const observedAt = input.observedAt;
    const tierRead = { store: input.store, readBuilderTier: input.readBuilderTier, uid: input.uid, now: input.now ?? Date.now() };
    return withCurrentBuilderTier(tierRead, ({ tier: entitlementTier, assertCurrent }) => input.store.transaction({ label: "builder-activation-lease.request" }, async (transaction) => {
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
        const eligibility = activationDemandEligibility(builder, entitlementTier);
        if ("result" in eligibility)
            return eligibility.result;
        const { sizingTier, slug } = eligibility;
        const existing = builder.activationLease;
        const leaseFence = { leaseId: existing?.leaseId ?? null, generation: existing?.generation ?? null };
        const duplicate = parkedDuplicateForEvent(existing, eventKey);
        if (duplicate)
            return duplicate;
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
            entitlementTier: eligibility.entitlementTier,
            sizingTier,
        };
        await transaction.builders.records.setActivationLease(input.uid, next, leaseFence);
        return demandBody({ lease: next, status: "requested", sizingTier });
    }));
}
function runtimeOperationSuffix(gatewayId, generation) {
    if (gatewayId.length === 0)
        throw new Error("Builder runtime operation needs a gateway id");
    if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error(`Builder runtime operation needs a positive generation, got ${generation}`);
    }
    return `${gatewayId}-g${generation}`;
}
export function builderActivateOperationId(gatewayId, generation) {
    return `builder-activate-${runtimeOperationSuffix(gatewayId, generation)}`;
}
export function builderReturnOperationId(gatewayId, generation) {
    return `builder-return-${runtimeOperationSuffix(gatewayId, generation)}`;
}
export function builderRecoverOperationId(gatewayId, generation) {
    return `builder-recover-${runtimeOperationSuffix(gatewayId, generation)}`;
}
export function placementRetireOperationId(uid, gatewayId, generation) {
    if (uid.length === 0)
        throw new Error("placement retirement needs an owner uid");
    return `placement-retire-${uid}-${runtimeOperationSuffix(gatewayId, generation)}`;
}
function runtimeOperationIdMatches(prefix, operationId, gatewayId) {
    if (typeof operationId !== "string" || typeof gatewayId !== "string" || gatewayId.length === 0)
        return false;
    const head = `${prefix}${gatewayId}-g`;
    return operationId.startsWith(head) && /^[1-9]\d*$/.test(operationId.slice(head.length));
}
export function isBuilderActivateOperationIdFor(operationId, gatewayId) {
    return runtimeOperationIdMatches("builder-activate-", operationId, gatewayId);
}
export function isBuilderReturnOperationIdFor(operationId, gatewayId) {
    return runtimeOperationIdMatches("builder-return-", operationId, gatewayId);
}
