// Onboarding gateway placement: which gateway a new customer lands on.
// config/orchestrator holds ONE default plus per-uid overrides, and it is
// PLACEMENT ONLY — no model, tier, or billing meaning ever rides this doc.
// Entitlements resolve from the account (resolveEffectivePlan); gateway class
// is capacity/security topology. Whys: DECISIONS.md 2026-07-03.
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
export function resolveOnboardingPlacementForUid(uid, config) {
    const override = config.overrides?.[uid];
    if (override)
        return { kind: "gateway-override", gatewayId: override };
    return { kind: "default", gatewayId: config.defaultGatewayId };
}
export function rewritePlacementGatewayPointers(config, sourceGatewayId, targetGatewayId) {
    const changedPointers = [];
    const next = {
        ...config,
        ...(config.overrides ? { overrides: { ...config.overrides } } : {}),
        ...(config.onboardingCohorts
            ? {
                onboardingCohorts: Object.fromEntries(Object.entries(config.onboardingCohorts).map(([name, cohort]) => [
                    name,
                    { ...cohort },
                ])),
            }
            : {}),
    };
    if (next.defaultGatewayId === sourceGatewayId) {
        next.defaultGatewayId = targetGatewayId;
        changedPointers.unshift("defaultGatewayId");
    }
    if (next.overrides) {
        for (const [uid, gatewayId] of Object.entries(next.overrides)) {
            if (gatewayId !== sourceGatewayId)
                continue;
            next.overrides[uid] = targetGatewayId;
            changedPointers.push(`overrides.${uid}`);
        }
    }
    if (next.onboardingCohorts) {
        for (const [name, cohort] of Object.entries(next.onboardingCohorts)) {
            if (cohort.gatewayId !== sourceGatewayId)
                continue;
            cohort.gatewayId = targetGatewayId;
            changedPointers.push(`onboardingCohorts.${name}.gatewayId`);
        }
    }
    return { config: next, changedPointers };
}
