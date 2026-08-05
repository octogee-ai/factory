import { describe, expect, it } from "vitest";

import {
  resolveContinuousBuilderPlacement,
  resolveOnboardingPlacementEligibility,
} from "./orchestrator-placement.js";

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

const trialBuilder = {
  trialGrant: {
    schemaVersion: 3,
    offerId: "builder-signup",
    offerVersion: 1,
    personalTier: "personal",
    builderTier: "hobby",
    configHash: "grant-hash",
    claimedAt: 1_000,
    endsAt: 604_801_000,
  },
};

describe("resolveContinuousBuilderPlacement", () => {
  it("keeps an entitled inactive Builder parked on shared", () => {
    expect(resolveContinuousBuilderPlacement({
      uid: "uid-alice",
      userData: trialBuilder,
      currentGatewayId: "shared-blue",
      defaultGatewayId: "shared-blue",
      ownedGateway: {
        gatewayId: "builder-alice",
        gatewayClass: "builder",
        ownerUid: "uid-alice",
        desiredStatus: "running",
        ready: true,
      },
      now: new Date(1_000),
    })).toEqual({ targetGatewayId: "shared-blue", ownedGatewayId: null });
  });

  it("returns expired and unentitled Builders to the configured default", () => {
    expect(resolveContinuousBuilderPlacement({
      uid: "uid-alice",
      userData: trialBuilder,
      currentGatewayId: "builder-alice",
      defaultGatewayId: "shared-blue",
      ownedGateway: null,
      now: new Date("2027-01-01T00:00:00.000Z"),
    })).toEqual({ targetGatewayId: "shared-blue", ownedGatewayId: null });
  });

  it("does not treat a paid entitlement as runtime demand", () => {
    expect(resolveContinuousBuilderPlacement({
      uid: "uid-paid",
      userData: { builderSubscription: { tier: "pro", status: "active" } },
      currentGatewayId: "shared-blue",
      defaultGatewayId: "shared-blue",
      ownedGateway: null,
      now: new Date(1_000),
    })).toEqual({ targetGatewayId: "shared-blue", ownedGatewayId: null });
  });

  it("keeps an active lease target stable during a heartbeat outage", () => {
    expect(resolveContinuousBuilderPlacement({
      uid: "uid-alice",
      userData: {
        ...trialBuilder,
        provisioning: {
          openclaw: {
            activationLease: {
              status: "active",
              targetGatewayId: "builder-alice",
            },
          },
        },
      },
      currentGatewayId: "builder-alice",
      defaultGatewayId: "shared-blue",
      ownedGateway: {
        gatewayId: "builder-alice",
        gatewayClass: "builder",
        ownerUid: "uid-alice",
        disposable: true,
        desiredStatus: "running",
        ready: false,
      },
      now: new Date(1_000),
    })).toEqual({ targetGatewayId: "builder-alice", ownedGatewayId: "builder-alice" });
  });

  it("does not route an active lease to a non-disposable owner gateway", () => {
    expect(resolveContinuousBuilderPlacement({
      uid: "uid-alice",
      userData: {
        ...trialBuilder,
        provisioning: {
          openclaw: {
            activationLease: { status: "active", targetGatewayId: "builder-alice" },
          },
        },
      },
      currentGatewayId: "builder-alice",
      defaultGatewayId: "shared-blue",
      ownedGateway: {
        gatewayId: "builder-alice",
        gatewayClass: "builder",
        ownerUid: "uid-alice",
        desiredStatus: "running",
        ready: true,
      },
      now: new Date(1_000),
    })).toEqual({ targetGatewayId: "shared-blue", ownedGatewayId: "builder-alice" });
  });
});
