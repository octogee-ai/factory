import { describe, expect, it } from "vitest";
import {
  resolveOnboardingPlacementEligibility,
} from "./orchestrator-placement";

describe("onboarding placement eligibility", () => {
  it("accepts only completed identity onboarding with a server-started provisioning state", () => {
    expect(resolveOnboardingPlacementEligibility({
      username: "alice",
      onboardingStep: "complete",
      provisioning: { status: "in_progress", openclaw: {} },
    })).toEqual({ eligible: true, slug: "alice" });
    expect(resolveOnboardingPlacementEligibility({
      username: "alice",
      onboardingStep: "complete",
      provisioning: { status: "complete", openclaw: { slug: "canonical" } },
    })).toEqual({ eligible: true, slug: "canonical" });
  });

  it("rejects incomplete identity, missing canonical identity, and arbitrary provisioning states", () => {
    expect(resolveOnboardingPlacementEligibility({ username: "alice" })).toEqual({
      eligible: false,
      reason: "onboarding-incomplete",
    });
    expect(resolveOnboardingPlacementEligibility({
      onboardingStep: "complete",
      provisioning: { status: "in_progress" },
    })).toEqual({ eligible: false, reason: "builder-slug-missing" });
    expect(resolveOnboardingPlacementEligibility({
      username: "alice",
      onboardingStep: "complete",
      provisioning: { status: "queued" },
    })).toEqual({ eligible: false, reason: "provisioning-not-started" });
  });
});
