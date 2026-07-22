export interface OnboardingOrchestratorConfig {
  defaultGatewayId: string;
}

export type OnboardingPlacementEligibility =
  | { eligible: true; slug: string }
  | {
      eligible: false;
      reason: "onboarding-incomplete" | "provisioning-not-started" | "builder-slug-missing";
    };

export function resolveOnboardingPlacementEligibility(
  data: Record<string, unknown>,
): OnboardingPlacementEligibility {
  if (data.onboardingStep !== "complete") {
    return { eligible: false, reason: "onboarding-incomplete" };
  }
  const provisioning = data.provisioning as Record<string, unknown> | undefined;
  if (provisioning?.status !== "in_progress" && provisioning?.status !== "complete") {
    return { eligible: false, reason: "provisioning-not-started" };
  }
  const openclaw = provisioning.openclaw as Record<string, unknown> | undefined;
  const slugCandidate = typeof openclaw?.slug === "string" ? openclaw.slug : data.username;
  const slug = typeof slugCandidate === "string" ? slugCandidate.trim() : "";
  return slug
    ? { eligible: true, slug }
    : { eligible: false, reason: "builder-slug-missing" };
}
