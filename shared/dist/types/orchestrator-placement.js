import { resolveBuilderTier, resolvePaidBuilderTier } from "./billing.js";
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
export function resolveEntitledOwnedGatewayId(input) {
    if (resolvePaidBuilderTier(input.userData) !== null) {
        const status = input.reservation?.status;
        return status === "provisioning" || status === "fulfilled"
            ? nonEmptyString(input.reservation?.gatewayId)
            : null;
    }
    if (resolveBuilderTier(input.userData, input.now) === null)
        return null;
    const trialGrant = input.userData.trialGrant;
    return trialGrant && typeof trialGrant === "object" && !Array.isArray(trialGrant)
        ? nonEmptyString(trialGrant.gatewayId)
        : null;
}
export function resolveContinuousBuilderPlacement(input) {
    const ownedGatewayId = resolveEntitledOwnedGatewayId(input);
    if (!ownedGatewayId) {
        return { targetGatewayId: input.defaultGatewayId, ownedGatewayId: null };
    }
    const gateway = input.ownedGateway;
    const ownedGatewayIsUsable = gateway !== null &&
        gateway.gatewayId === ownedGatewayId &&
        gateway.gatewayClass !== "shared" &&
        gateway.ownerUid === input.uid &&
        gateway.desiredStatus === "running" &&
        (gateway.ready || input.currentGatewayId === ownedGatewayId);
    return {
        targetGatewayId: ownedGatewayIsUsable ? ownedGatewayId : input.defaultGatewayId,
        ownedGatewayId,
    };
}
export function resolveOnboardingPlacementEligibility(data) {
    if (data.onboardingStep !== "complete") {
        return { eligible: false, reason: "onboarding-incomplete" };
    }
    const provisioning = data.provisioning;
    if (provisioning?.status !== "in_progress" && provisioning?.status !== "complete") {
        return { eligible: false, reason: "provisioning-not-started" };
    }
    const openclaw = provisioning.openclaw;
    const slugCandidate = typeof openclaw?.slug === "string" ? openclaw.slug : data.username;
    const slug = typeof slugCandidate === "string" ? slugCandidate.trim() : "";
    return slug
        ? { eligible: true, slug }
        : { eligible: false, reason: "builder-slug-missing" };
}
