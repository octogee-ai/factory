import { TIER_PRESETS, } from "./sizing.js";
// Approximate GKE Autopilot c2d on-demand pricing (us-central1, 2026-05).
// Anchored to public rates; rounds up conservatively. Excludes egress, LB,
// GCS, Firestore - those are app-level metering territory (Phase 5a).
export const C2D_AUTOPILOT_VCPU_USD_PER_HR = 0.0335;
export const C2D_AUTOPILOT_GIB_USD_PER_HR = 0.00408;
export const HOURS_PER_MONTH = 730;
// Conservative Spot estimate for the gateway ComputeClass. Specs model Spot
// at roughly 70-90% off; use 70% off so the dashboard does not overstate
// savings.
export const SPOT_PRICE_MULTIPLIER = 0.3;
export function estimateGatewayMonthlyCost(tier, opts = {}) {
    const preset = TIER_PRESETS[tier];
    const pricingMode = opts.pricingMode ?? "on-demand";
    const onDemandCompute = computeMonthlyUsd(preset);
    const compute = onDemandCompute * priceMultiplierFor(pricingMode);
    return {
        computeUsd: Math.round(compute),
        onDemandComputeUsd: Math.round(onDemandCompute),
        savingsUsd: Math.max(0, Math.round(onDemandCompute) - Math.round(compute)),
        pricingMode,
        perBuilderAtTarget: Math.round(compute / preset.capacity.targetActiveBuilders),
        perBuilderAtTypical: Math.round(compute / preset.capacity.typicalBuilders),
    };
}
export function estimateFleetMonthlyCost(inputs) {
    const byTier = {};
    let total = 0;
    let onDemandTotal = 0;
    for (const input of inputs) {
        const tier = typeof input === "string" ? input : input.tier;
        const pricingMode = typeof input === "string" ? "on-demand" : input.pricingMode;
        const cost = estimateGatewayMonthlyCost(tier, { pricingMode });
        total += cost.computeUsd;
        onDemandTotal += cost.onDemandComputeUsd;
        const entry = byTier[tier] ?? {
            count: 0,
            subtotalUsd: 0,
            onDemandSubtotalUsd: 0,
            spotCount: 0,
            onDemandCount: 0,
        };
        entry.count += 1;
        entry.subtotalUsd += cost.computeUsd;
        entry.onDemandSubtotalUsd += cost.onDemandComputeUsd;
        if (cost.pricingMode === "spot")
            entry.spotCount += 1;
        else
            entry.onDemandCount += 1;
        byTier[tier] = entry;
    }
    return {
        totalUsd: total,
        onDemandTotalUsd: onDemandTotal,
        savingsUsd: Math.max(0, onDemandTotal - total),
        byTier,
    };
}
function computeMonthlyUsd(preset) {
    const vcpu = parseMillicores(preset.resources.requests.cpu) / 1000;
    const gib = parseGiB(preset.resources.requests.memory);
    return (vcpu * C2D_AUTOPILOT_VCPU_USD_PER_HR * HOURS_PER_MONTH +
        gib * C2D_AUTOPILOT_GIB_USD_PER_HR * HOURS_PER_MONTH);
}
function priceMultiplierFor(mode) {
    return mode === "spot" ? SPOT_PRICE_MULTIPLIER : 1;
}
function parseMillicores(s) {
    const m = /^(\d+)m$/.exec(s);
    if (!m)
        throw new Error(`cost-estimator: unexpected cpu format "${s}" — expected "<N>m"`);
    return parseInt(m[1], 10);
}
function parseGiB(s) {
    const m = /^(\d+)Gi$/.exec(s);
    if (!m)
        throw new Error(`cost-estimator: unexpected memory format "${s}" — expected "<N>Gi"`);
    return parseInt(m[1], 10);
}
