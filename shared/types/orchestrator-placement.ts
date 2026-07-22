import { resolveBuilderTier, resolvePaidBuilderTier } from "./billing.js";

export interface OnboardingOrchestratorConfig {
  defaultGatewayId: string;
}

export interface ContinuousPlacementOwnedGateway {
  gatewayId: string;
  gatewayClass: string;
  ownerUid: string | null;
  desiredStatus: string;
  ready: boolean;
}

export interface ContinuousBuilderPlacementInput {
  uid: string;
  userData: Record<string, unknown>;
  reservation: Record<string, unknown> | null;
  currentGatewayId: string | null;
  defaultGatewayId: string;
  ownedGateway: ContinuousPlacementOwnedGateway | null;
  now?: Date;
}

export interface ContinuousBuilderPlacement {
  targetGatewayId: string;
  ownedGatewayId: string | null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function resolveEntitledOwnedGatewayId(input: Pick<
  ContinuousBuilderPlacementInput,
  "userData" | "reservation" | "now"
>): string | null {
  if (resolvePaidBuilderTier(input.userData) !== null) {
    const status = input.reservation?.status;
    return status === "provisioning" || status === "fulfilled"
      ? nonEmptyString(input.reservation?.gatewayId)
      : null;
  }
  if (resolveBuilderTier(input.userData, input.now) === null) return null;
  const trialGrant = input.userData.trialGrant;
  return trialGrant && typeof trialGrant === "object" && !Array.isArray(trialGrant)
    ? nonEmptyString((trialGrant as Record<string, unknown>).gatewayId)
    : null;
}

export function resolveContinuousBuilderPlacement(
  input: ContinuousBuilderPlacementInput,
): ContinuousBuilderPlacement {
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
