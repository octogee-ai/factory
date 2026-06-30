import { describe, expect, it } from "vitest";
import {
  MODEL_BROKER_RATE_WINDOW_MS,
  MODEL_BROKER_RATE_WINDOWS_COLLECTION,
  MODEL_BROKER_USAGE_EVENTS_COLLECTION,
  MODEL_BROKER_USAGE_ROLLUPS_COLLECTION,
  MODEL_BROKER_USAGE_WINDOW_MS,
  MODEL_BROKER_USAGE_WINDOWS_COLLECTION,
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
});
