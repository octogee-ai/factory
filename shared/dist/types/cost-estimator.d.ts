import { type SizingTier } from "./sizing.js";
export declare const C2D_AUTOPILOT_VCPU_USD_PER_HR = 0.0335;
export declare const C2D_AUTOPILOT_GIB_USD_PER_HR = 0.00408;
export declare const HOURS_PER_MONTH = 730;
export declare const SPOT_PRICE_MULTIPLIER = 0.3;
export type GatewayPricingMode = "on-demand" | "spot";
export interface GatewayMonthlyCost {
    computeUsd: number;
    onDemandComputeUsd: number;
    savingsUsd: number;
    pricingMode: GatewayPricingMode;
    perBuilderAtTarget: number;
    perBuilderAtTypical: number;
}
export interface FleetMonthlyCost {
    totalUsd: number;
    onDemandTotalUsd: number;
    savingsUsd: number;
    byTier: Partial<Record<SizingTier, {
        count: number;
        subtotalUsd: number;
        onDemandSubtotalUsd: number;
        spotCount: number;
        onDemandCount: number;
    }>>;
}
export declare function estimateGatewayMonthlyCost(tier: SizingTier, opts?: {
    pricingMode?: GatewayPricingMode;
}): GatewayMonthlyCost;
export declare function estimateFleetMonthlyCost(inputs: Array<SizingTier | {
    tier: SizingTier;
    pricingMode?: GatewayPricingMode;
}>): FleetMonthlyCost;
