import { describe, expect, it } from "vitest";
import {
  C2D_AUTOPILOT_VCPU_USD_PER_HR,
  C2D_AUTOPILOT_GIB_USD_PER_HR,
  HOURS_PER_MONTH,
  estimateGatewayMonthlyCost,
  estimateFleetMonthlyCost,
} from "./cost-estimator.js";
import { TIER_PRESETS, SIZING_TIERS } from "./sizing.js";

describe("estimateGatewayMonthlyCost", () => {
  it("computes compute cost from request CPU + memory at c2d Autopilot rates", () => {
    // cattle-light: 4 vCPU / 12 GiB
    const result = estimateGatewayMonthlyCost("cattle-light");
    const expected = Math.round(
      4 * C2D_AUTOPILOT_VCPU_USD_PER_HR * HOURS_PER_MONTH +
        12 * C2D_AUTOPILOT_GIB_USD_PER_HR * HOURS_PER_MONTH,
    );
    expect(result.computeUsd).toBe(expected);
  });

  it("derives perBuilderAtTarget and perBuilderAtTypical from raw compute and tier capacity", () => {
    const preset = TIER_PRESETS["cattle-light"];
    const rawCompute =
      4 * C2D_AUTOPILOT_VCPU_USD_PER_HR * HOURS_PER_MONTH +
      12 * C2D_AUTOPILOT_GIB_USD_PER_HR * HOURS_PER_MONTH;
    const result = estimateGatewayMonthlyCost("cattle-light");
    expect(result.perBuilderAtTarget).toBe(Math.round(rawCompute / preset.capacity.targetActiveBuilders));
    expect(result.perBuilderAtTypical).toBe(Math.round(rawCompute / preset.capacity.typicalBuilders));
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

  it("operator-plus is the most expensive tier", () => {
    const top = estimateGatewayMonthlyCost("operator-plus").computeUsd;
    for (const tier of SIZING_TIERS) {
      if (tier === "operator-plus") continue;
      expect(top).toBeGreaterThanOrEqual(estimateGatewayMonthlyCost(tier).computeUsd);
    }
  });

  it("cattle-heavy lands in a sane range for the current PROD floor (≤ $1000/mo)", () => {
    // cattle-heavy = 12 vCPU / 32 GiB, the current PROD pod floor.
    // Anchor sanity: should be well under $1000/mo at c2d Autopilot rates.
    const c = estimateGatewayMonthlyCost("cattle-heavy").computeUsd;
    expect(c).toBeGreaterThan(300);
    expect(c).toBeLessThan(1000);
  });
});

describe("estimateFleetMonthlyCost", () => {
  it("sums per-pod compute across all input tiers", () => {
    const result = estimateFleetMonthlyCost(["cattle-heavy", "operator"]);
    expect(result.totalUsd).toBe(
      estimateGatewayMonthlyCost("cattle-heavy").computeUsd +
        estimateGatewayMonthlyCost("operator").computeUsd,
    );
  });

  it("returns per-tier breakdown counts and subtotals", () => {
    const result = estimateFleetMonthlyCost([
      "cattle-heavy",
      "cattle-heavy",
      "operator",
    ]);
    expect(result.byTier["cattle-heavy"]).toEqual({
      count: 2,
      subtotalUsd: 2 * estimateGatewayMonthlyCost("cattle-heavy").computeUsd,
    });
    expect(result.byTier.operator).toEqual({
      count: 1,
      subtotalUsd: estimateGatewayMonthlyCost("operator").computeUsd,
    });
  });

  it("empty fleet returns zero total and empty breakdown", () => {
    const result = estimateFleetMonthlyCost([]);
    expect(result.totalUsd).toBe(0);
    expect(result.byTier).toEqual({});
  });
});
