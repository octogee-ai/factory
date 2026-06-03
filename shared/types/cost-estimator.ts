import {
  TIER_PRESETS,
  type SizingTier,
  type SizingTierPreset,
} from "./sizing.js";

// Approximate GKE Autopilot c2d on-demand pricing (us-central1, 2026-05).
// Anchored to public rates; rounds up conservatively. Excludes egress, LB,
// GCS, Firestore — those are app-level metering territory (Phase 5a).
export const C2D_AUTOPILOT_VCPU_USD_PER_HR = 0.0335;
export const C2D_AUTOPILOT_GIB_USD_PER_HR = 0.00408;
export const HOURS_PER_MONTH = 730;

export interface GatewayMonthlyCost {
  computeUsd: number;
  perBuilderAtTarget: number;
  perBuilderAtTypical: number;
}

export interface FleetMonthlyCost {
  totalUsd: number;
  byTier: Partial<Record<SizingTier, { count: number; subtotalUsd: number }>>;
}

export function estimateGatewayMonthlyCost(tier: SizingTier): GatewayMonthlyCost {
  const preset = TIER_PRESETS[tier];
  const compute = computeMonthlyUsd(preset);
  return {
    computeUsd: Math.round(compute),
    perBuilderAtTarget: Math.round(compute / preset.capacity.targetActiveBuilders),
    perBuilderAtTypical: Math.round(compute / preset.capacity.typicalBuilders),
  };
}

export function estimateFleetMonthlyCost(tiers: SizingTier[]): FleetMonthlyCost {
  const byTier: FleetMonthlyCost["byTier"] = {};
  let total = 0;
  for (const tier of tiers) {
    const cost = estimateGatewayMonthlyCost(tier).computeUsd;
    total += cost;
    const entry = byTier[tier] ?? { count: 0, subtotalUsd: 0 };
    entry.count += 1;
    entry.subtotalUsd += cost;
    byTier[tier] = entry;
  }
  return { totalUsd: total, byTier };
}

function computeMonthlyUsd(preset: SizingTierPreset): number {
  const vcpu = parseMillicores(preset.resources.requests.cpu) / 1000;
  const gib = parseGiB(preset.resources.requests.memory);
  return (
    vcpu * C2D_AUTOPILOT_VCPU_USD_PER_HR * HOURS_PER_MONTH +
    gib * C2D_AUTOPILOT_GIB_USD_PER_HR * HOURS_PER_MONTH
  );
}

function parseMillicores(s: string): number {
  const m = /^(\d+)m$/.exec(s);
  if (!m) throw new Error(`cost-estimator: unexpected cpu format "${s}" — expected "<N>m"`);
  return parseInt(m[1], 10);
}

function parseGiB(s: string): number {
  const m = /^(\d+)Gi$/.exec(s);
  if (!m) throw new Error(`cost-estimator: unexpected memory format "${s}" — expected "<N>Gi"`);
  return parseInt(m[1], 10);
}
