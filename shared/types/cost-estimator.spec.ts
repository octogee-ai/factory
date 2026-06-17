import { describe, expect, it } from "vitest";
import {
  C2D_AUTOPILOT_VCPU_USD_PER_HR,
  C2D_AUTOPILOT_GIB_USD_PER_HR,
  HOURS_PER_MONTH,
  SPOT_PRICE_MULTIPLIER,
  estimateGatewayMonthlyCost,
  estimateFleetMonthlyCost,
} from "./cost-estimator.js";
import { TIER_PRESETS, SIZING_TIERS } from "./sizing.js";

describe("estimateGatewayMonthlyCost", () => {
  it("computes compute cost from request CPU + memory at c2d Autopilot rates", () => {
    // small: 4 vCPU / 16 GiB
    const result = estimateGatewayMonthlyCost("small");
    const expected = Math.round(
      4 * C2D_AUTOPILOT_VCPU_USD_PER_HR * HOURS_PER_MONTH +
        16 * C2D_AUTOPILOT_GIB_USD_PER_HR * HOURS_PER_MONTH,
    );
    expect(result.computeUsd).toBe(expected);
  });

  it("derives perBuilderAtTarget and perBuilderAtTypical from raw compute and tier capacity", () => {
    const preset = TIER_PRESETS["small"];
    const rawCompute =
      4 * C2D_AUTOPILOT_VCPU_USD_PER_HR * HOURS_PER_MONTH +
      16 * C2D_AUTOPILOT_GIB_USD_PER_HR * HOURS_PER_MONTH;
    const result = estimateGatewayMonthlyCost("small");
    expect(result.perBuilderAtTarget).toBe(Math.round(rawCompute / preset.capacity.targetActiveBuilders));
    expect(result.perBuilderAtTypical).toBe(Math.round(rawCompute / preset.capacity.typicalBuilders));
  });

  it("applies the conservative Spot multiplier when pricingMode=spot", () => {
    const onDemand = estimateGatewayMonthlyCost("small", { pricingMode: "on-demand" });
    const spot = estimateGatewayMonthlyCost("small", { pricingMode: "spot" });
    expect(spot.pricingMode).toBe("spot");
    expect(spot.computeUsd).toBe(Math.round(onDemand.onDemandComputeUsd * SPOT_PRICE_MULTIPLIER));
    expect(spot.onDemandComputeUsd).toBe(onDemand.computeUsd);
    expect(spot.savingsUsd).toBe(onDemand.computeUsd - spot.computeUsd);
  });

  it("rounds to whole dollars", () => {
    for (const tier of SIZING_TIERS) {
      const result = estimateGatewayMonthlyCost(tier);
      expect(Number.isInteger(result.computeUsd)).toBe(true);
      expect(Number.isInteger(result.perBuilderAtTarget)).toBe(true);
      expect(Number.isInteger(result.perBuilderAtTypical)).toBe(true);
    }
  });

  it("returns monotonically non-decreasing compute cost across the tier ladder", () => {
    let prev = -Infinity;
    for (const tier of SIZING_TIERS) {
      const c = estimateGatewayMonthlyCost(tier).computeUsd;
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });

  it("2xlarge is the most expensive tier", () => {
    const top = estimateGatewayMonthlyCost("2xlarge").computeUsd;
    for (const tier of SIZING_TIERS) {
      if (tier === "2xlarge") continue;
      expect(top).toBeGreaterThanOrEqual(estimateGatewayMonthlyCost(tier).computeUsd);
    }
  });

  it("small (the default tier) lands in a sane low range for F&F", () => {
    // small = 4 vCPU / 16 GiB, the default tier most gateways start on.
    // Anchor sanity: a cheap F&F floor, comfortably under $300/mo.
    const c = estimateGatewayMonthlyCost("small").computeUsd;
    expect(c).toBeGreaterThan(100);
    expect(c).toBeLessThan(300);
  });
});

describe("estimateFleetMonthlyCost", () => {
  it("sums per-pod compute across all input tiers", () => {
    const result = estimateFleetMonthlyCost(["medium", "large"]);
    expect(result.totalUsd).toBe(
      estimateGatewayMonthlyCost("medium").computeUsd +
        estimateGatewayMonthlyCost("large").computeUsd,
    );
  });

  it("returns per-tier breakdown counts and subtotals", () => {
    const result = estimateFleetMonthlyCost([
      { tier: "medium", pricingMode: "spot" },
      "medium",
      "large",
    ]);
    expect(result.byTier["medium"]).toEqual({
      count: 2,
      subtotalUsd:
        estimateGatewayMonthlyCost("medium", { pricingMode: "spot" }).computeUsd +
        estimateGatewayMonthlyCost("medium").computeUsd,
      onDemandSubtotalUsd: 2 * estimateGatewayMonthlyCost("medium").computeUsd,
      spotCount: 1,
      onDemandCount: 1,
    });
    expect(result.byTier.large).toEqual({
      count: 1,
      subtotalUsd: estimateGatewayMonthlyCost("large").computeUsd,
      onDemandSubtotalUsd: estimateGatewayMonthlyCost("large").computeUsd,
      spotCount: 0,
      onDemandCount: 1,
    });
    expect(result.onDemandTotalUsd).toBe(
      2 * estimateGatewayMonthlyCost("medium").computeUsd +
        estimateGatewayMonthlyCost("large").computeUsd,
    );
    expect(result.savingsUsd).toBeGreaterThan(0);
  });

  it("empty fleet returns zero total and empty breakdown", () => {
    const result = estimateFleetMonthlyCost([]);
    expect(result.totalUsd).toBe(0);
    expect(result.onDemandTotalUsd).toBe(0);
    expect(result.savingsUsd).toBe(0);
    expect(result.byTier).toEqual({});
  });
});
