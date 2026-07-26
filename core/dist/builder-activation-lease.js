import { randomUUID } from "node:crypto";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { resolveBuilderTier } from "@octogee/shared/types/billing";
import { BUILDER_TIERS } from "@octogee/shared/types/billing-tiers";
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
function userGatewayId(userData) {
    const provisioning = record(userData.provisioning);
    const openclaw = record(provisioning?.openclaw);
    return nonEmptyString(openclaw?.gatewayId);
}
function userLease(userData) {
    const provisioning = record(userData.provisioning);
    const openclaw = record(provisioning?.openclaw);
    return record(openclaw?.activationLease);
}
function builderSlug(userData) {
    const provisioning = record(userData.provisioning);
    const openclaw = record(provisioning?.openclaw);
    return nonEmptyString(openclaw?.slug) ?? nonEmptyString(userData.username);
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
    const assignment = input.assignmentData;
    return userGatewayId(input.userData) === input.reportingGatewayId &&
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
export async function requestBuilderActivationLease(input) {
    const invalid = invalidRequest(input);
    if (invalid)
        return invalid;
    const reportingGatewayId = input.reportingGatewayId;
    const assignmentEpoch = input.assignmentEpoch;
    const eventKey = input.eventKey;
    const cause = input.cause;
    const observedAt = input.observedAt;
    const userRef = input.db.doc(`users/${input.uid}`);
    const assignmentRef = input.db.doc(`gateways/${reportingGatewayId}/assignments/${input.uid}`);
    // eslint-disable-next-line complexity
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
        const userData = userSnapshot.data();
        const assignmentData = assignmentSnapshot.exists
            ? assignmentSnapshot.data()
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
        if (!accountAllowsInteractiveAccess(userData)) {
            return {
                statusCode: 403,
                body: {
                    code: "builder-runtime-not-interactive",
                    error: "account does not allow interactive runtime access",
                },
            };
        }
        const entitlementTier = resolveBuilderTier(userData, new Date(input.now ?? Date.now()));
        if (!entitlementTier) {
            return {
                statusCode: 403,
                body: {
                    code: "builder-runtime-not-entitled",
                    error: "Builder runtime entitlement is required",
                },
            };
        }
        const sizingTier = BUILDER_TIERS[entitlementTier].instance;
        if (!sizingTier) {
            return {
                statusCode: 409,
                body: {
                    code: "builder-runtime-manual-size-required",
                    error: "Builder entitlement requires an explicit operator size",
                    entitlementTier,
                },
            };
        }
        const slug = builderSlug(userData);
        if (!slug) {
            return {
                statusCode: 409,
                body: {
                    code: "builder-runtime-slug-missing",
                    error: "Builder runtime identity is missing a slug",
                },
            };
        }
        const existing = userLease(userData);
        if (existing?.status === "returning" &&
            nonEmptyString(existing.leaseId) &&
            positiveInteger(existing.generation)) {
            const priorPending = record(existing.pendingDemand);
            const priorObservedAt = typeof priorPending?.observedAt === "number"
                ? priorPending.observedAt
                : -1;
            const pendingDemand = priorObservedAt > observedAt
                ? priorPending
                : {
                    eventKey,
                    cause,
                    observedAt,
                    sourceGatewayId: reportingGatewayId,
                    sourceAssignmentEpoch: assignmentEpoch,
                };
            const next = { ...existing, pendingDemand };
            transaction.update(userRef, {
                "provisioning.openclaw.activationLease": next,
            });
            return demandBody({
                lease: next,
                status: "returning",
                sizingTier,
                pending: true,
            });
        }
        if (existingLeaseCanAdopt(existing)) {
            const next = {
                ...existing,
                status: existing.status,
                lastActiveAt: Math.max(typeof existing?.lastActiveAt === "number" ? existing.lastActiveAt : 0, observedAt),
                lastEventKey: eventKey,
            };
            transaction.update(userRef, {
                "provisioning.openclaw.activationLease": next,
            });
            return demandBody({
                lease: next,
                status: String(next.status),
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
