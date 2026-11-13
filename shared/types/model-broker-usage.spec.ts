import { describe, expect, it } from "vitest";
import {
  exhaustedSpendBudget,
  MODEL_BROKER_RATE_WINDOW_MS,
  MODEL_BROKER_RATE_WINDOWS_COLLECTION,
  MODEL_BROKER_USAGE_EVENTS_COLLECTION,
  MODEL_BROKER_USAGE_ROLLUPS_COLLECTION,
  MODEL_BROKER_USAGE_WINDOW_MS,
  MODEL_BROKER_USAGE_WINDOWS_COLLECTION,
  MODEL_BROKER_WEEK_WINDOW_MS,
  MODEL_BROKER_WEEK_WINDOWS_COLLECTION,
  modelBrokerWindowDocId,
  rateWindowStartMs,
  spendWindowPercentUsed,
  usageWindowStartMs,
  weekWindowStartMs,
  windowOwnerKey,
} from "./model-broker-usage.js";

describe("model broker usage storage contract", () => {
  it("keeps collection names and window durations stable", () => {
    expect(MODEL_BROKER_USAGE_EVENTS_COLLECTION).toBe("modelBrokerUsageEvents");
    expect(MODEL_BROKER_USAGE_ROLLUPS_COLLECTION).toBe("modelBrokerUsageRollups");
    expect(MODEL_BROKER_USAGE_WINDOWS_COLLECTION).toBe("modelBrokerUsageWindows");
    expect(MODEL_BROKER_RATE_WINDOWS_COLLECTION).toBe("modelBrokerRateWindows");
    expect(MODEL_BROKER_USAGE_WINDOW_MS).toBe(4 * 60 * 60 * 1000);
    expect(MODEL_BROKER_RATE_WINDOW_MS).toBe(60 * 1000);
  });

  it("keys windows by billing owner when present and gateway otherwise", () => {
    expect(windowOwnerKey({ ownerUid: "owner-1", gatewayId: "gw-1" })).toBe("owner-1");
    expect(windowOwnerKey({ ownerUid: null, gatewayId: "gw-1" })).toBe("gw-1");
    expect(modelBrokerWindowDocId("owner-1", 3_600_000)).toBe("owner-1_3600000");
  });

  it("rounds timestamps down to usage and rate windows", () => {
    expect(usageWindowStartMs(14_400_000 + 123)).toBe(14_400_000);
    expect(rateWindowStartMs(125_999)).toBe(120_000);
  });

  it("keys the weekly spend ledger by epoch-aligned 7-day windows", () => {
    expect(MODEL_BROKER_WEEK_WINDOWS_COLLECTION).toBe("modelBrokerWeekWindows");
    expect(MODEL_BROKER_WEEK_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(weekWindowStartMs(MODEL_BROKER_WEEK_WINDOW_MS + 123)).toBe(
      MODEL_BROKER_WEEK_WINDOW_MS,
    );
    // 2026-07-06T10:46Z (a Monday) floors to the Thursday-epoch week start 2026-07-02
    expect(weekWindowStartMs(Date.UTC(2026, 6, 6, 10, 46))).toBe(Date.UTC(2026, 6, 2));
  });

  it("pins the window doc keying", () => {
    expect(modelBrokerWindowDocId("owner-1", Date.UTC(2026, 6, 2))).toBe(
      `owner-1_${Date.UTC(2026, 6, 2)}`,
    );
  });
});

describe("spendWindowPercentUsed", () => {
  it("maps window spend onto a clamped 0-100 percentage", () => {
    expect(spendWindowPercentUsed(0, 2)).toBe(0);
    expect(spendWindowPercentUsed(1, 2)).toBe(50);
    expect(spendWindowPercentUsed(2, 2)).toBe(100);
    expect(spendWindowPercentUsed(5, 2)).toBe(100);
  });

  it("treats a zero budget (free / post-trial) as fully used", () => {
    expect(spendWindowPercentUsed(0, 0)).toBe(100);
  });
});

describe("exhaustedSpendBudget", () => {
  const under = { windowCostUsd: 1, windowBudgetUsd: 4, weekCostUsd: 2, weekBudgetUsd: 20 };

  it("reports no exhaustion while both budgets have room", () => {
    expect(exhaustedSpendBudget(under)).toBeNull();
  });

  it("reports the window when only the window is spent", () => {
    expect(exhaustedSpendBudget({ ...under, windowCostUsd: 4 })).toBe("window");
  });

  it("reports the week ahead of the window when both are spent", () => {
    expect(exhaustedSpendBudget({ ...under, windowCostUsd: 4, weekCostUsd: 20 })).toBe("week");
  });
});
