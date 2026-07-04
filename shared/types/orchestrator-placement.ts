// Onboarding gateway placement: which gateway a new customer lands on.
// config/orchestrator holds ONE default plus per-uid overrides, and it is
// PLACEMENT ONLY — no model, tier, or billing meaning ever rides this doc.
// Entitlements resolve from the account (resolveEffectivePlan); gateway class
// is capacity/security topology. Whys: DECISIONS.md 2026-07-03.

export interface OnboardingOrchestratorConfig {
  defaultGatewayId: string;
  overrides?: Record<string, string>;
}

export type OnboardingPlacementDecision =
  | { kind: "gateway-override"; gatewayId: string }
  | { kind: "default"; gatewayId: string };

export interface PlacementPointerRewriteResult {
  config: OnboardingOrchestratorConfig;
  changedPointers: string[];
}

export function resolveOnboardingPlacementForUid(
  uid: string,
  config: OnboardingOrchestratorConfig,
): OnboardingPlacementDecision {
  const override = config.overrides?.[uid];
  if (override) return { kind: "gateway-override", gatewayId: override };
  return { kind: "default", gatewayId: config.defaultGatewayId };
}

export function rewritePlacementGatewayPointers(
  config: OnboardingOrchestratorConfig,
  sourceGatewayId: string,
  targetGatewayId: string,
): PlacementPointerRewriteResult {
  const changedPointers: string[] = [];
  const next: OnboardingOrchestratorConfig = {
    ...config,
    overrides: config.overrides ? { ...config.overrides } : undefined,
  };

  if (next.defaultGatewayId === sourceGatewayId) {
    next.defaultGatewayId = targetGatewayId;
    changedPointers.unshift("defaultGatewayId");
  }

  if (next.overrides) {
    for (const [uid, gatewayId] of Object.entries(next.overrides)) {
      if (gatewayId !== sourceGatewayId) continue;
      next.overrides[uid] = targetGatewayId;
      changedPointers.push(`overrides.${uid}`);
    }
  }

  return { config: next, changedPointers };
}
