import { describe, expect, it } from "vitest";
import {
  MODEL_BROKER_CREDITS_COLLECTION,
  MODEL_BROKER_HOUSE_DAY_WINDOW_MS,
  MODEL_BROKER_HOUSE_DAY_WINDOWS_COLLECTION,
  MODEL_BROKER_RATE_WINDOW_MS,
  MODEL_BROKER_RATE_WINDOWS_COLLECTION,
  MODEL_BROKER_USAGE_EVENTS_COLLECTION,
  MODEL_BROKER_USAGE_ROLLUPS_COLLECTION,
  MODEL_BROKER_USAGE_WINDOW_MS,
  MODEL_BROKER_USAGE_WINDOWS_COLLECTION,
  houseDayStartMs,
  modelBrokerWindowDocId,
  rateWindowStartMs,
  usageWindowStartMs,
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

  it("keys the free house allowance by UTC day", () => {
    expect(MODEL_BROKER_HOUSE_DAY_WINDOWS_COLLECTION).toBe("modelBrokerHouseDayWindows");
    expect(MODEL_BROKER_CREDITS_COLLECTION).toBe("modelBrokerCredits");
    expect(MODEL_BROKER_HOUSE_DAY_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    // 2026-07-02T13:45:00Z floors to 2026-07-02T00:00:00Z
    expect(houseDayStartMs(Date.UTC(2026, 6, 2, 13, 45))).toBe(Date.UTC(2026, 6, 2));
    expect(houseDayStartMs(Date.UTC(2026, 6, 2))).toBe(Date.UTC(2026, 6, 2));
    expect(modelBrokerWindowDocId("owner-1", Date.UTC(2026, 6, 2))).toBe(
      `owner-1_${Date.UTC(2026, 6, 2)}`,
    );
  });
});
