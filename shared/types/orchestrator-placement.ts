// Onboarding gateway placement: which gateway a new customer lands on.
// config/orchestrator holds ONE default plus per-uid overrides — the cohort
// partition (per-cohort gateways + model stamping) died with the Personal
// plans; every gateway boots model-ready and models are a per-agent pick.

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
