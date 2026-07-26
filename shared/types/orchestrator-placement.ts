import { resolveBuilderTier } from "./billing.js";
import { accountAllowsInteractiveAccess } from "./account-lifecycle.js";
import type { DisposableBuilderGatewayAllocation } from "./gateway-mutable-config.js";

export interface OnboardingOrchestratorConfig {
  defaultGatewayId: string;
}

export interface ContinuousPlacementOwnedGateway {
  gatewayId: string;
  gatewayClass: string;
  ownerUid: string | null;
  desiredStatus: string;
  ready: boolean;
  disposable?: boolean;
  allocation?: DisposableBuilderGatewayAllocation | null;
}

export interface ContinuousBuilderPlacementInput {
  uid: string;
  userData: Record<string, unknown>;
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

export function resolveLiveActivationTargetGatewayId(input: Pick<
  ContinuousBuilderPlacementInput,
  "userData" | "now"
>): string | null {
  if (!accountAllowsInteractiveAccess(input.userData)) return null;
  if (resolveBuilderTier(input.userData, input.now) === null) return null;
  const provisioning = input.userData.provisioning;
  if (!provisioning || typeof provisioning !== "object" || Array.isArray(provisioning)) return null;
  const openclaw = (provisioning as Record<string, unknown>).openclaw;
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) return null;
  const lease = (openclaw as Record<string, unknown>).activationLease;
  if (!lease || typeof lease !== "object" || Array.isArray(lease)) return null;
  const status = (lease as Record<string, unknown>).status;
  if (status !== "provisioning" && status !== "activating" && status !== "active") return null;
  return nonEmptyString((lease as Record<string, unknown>).targetGatewayId);
}

export function resolveContinuousBuilderPlacement(
  input: ContinuousBuilderPlacementInput,
): ContinuousBuilderPlacement {
  const ownedGatewayId = resolveLiveActivationTargetGatewayId(input);
  if (!ownedGatewayId) {
    return { targetGatewayId: input.defaultGatewayId, ownedGatewayId: null };
  }
  const gateway = input.ownedGateway;
  const ownedGatewayIsUsable = gateway !== null &&
    gateway.gatewayId === ownedGatewayId &&
    gateway.gatewayClass !== "shared" &&
    gateway.ownerUid === input.uid &&
    gateway.desiredStatus === "running" &&
    input.currentGatewayId === ownedGatewayId;
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
