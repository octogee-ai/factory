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
