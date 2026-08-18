import { describe, expect, it } from "vitest";
import {
  POD_REPLACEMENT_WARNING_THRESHOLD_24H,
  isGatewayPodReplacements,
  summarizeGatewayPodReplacements,
  type GatewayPodReplacements,
} from "./gateway-pod-replacements";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_770_000_000_000;

function stored(overrides: Partial<GatewayPodReplacements> = {}): GatewayPodReplacements {
  return {
    recentAt: [],
    lastAt: null,
    lastVacatedPodUid: null,
    lastVacatedNodeName: null,
    lastVacatedInstanceId: null,
    lastVacatedNodePool: null,
    total: 0,
    ...overrides,
  };
}

describe("summarizeGatewayPodReplacements", () => {
  it("reports an empty summary when the gateway has never been tracked", () => {
    expect(summarizeGatewayPodReplacements(null, NOW)).toEqual({
      count24h: 0,
      count7d: 0,
      lastAt: null,
      lastVacatedPodUid: null,
      lastVacatedNodeName: null,
      lastVacatedInstanceId: null,
      lastVacatedNodePool: null,
      total: 0,
      warn: false,
    });
  });

  it("counts only losses inside each rolling window", () => {
    const summary = summarizeGatewayPodReplacements(
      stored({
        recentAt: [NOW - 6 * DAY, NOW - 2 * DAY, NOW - 3 * HOUR, NOW - HOUR],
        lastAt: NOW - HOUR,
        lastVacatedPodUid: "uid-d",
        total: 9,
      }),
      NOW,
    );
    expect(summary.count24h).toBe(2);
    expect(summary.count7d).toBe(4);
    expect(summary.total).toBe(9);
    expect(summary.lastVacatedPodUid).toBe("uid-d");
  });

  it("passes the vacated instance identity through for the preemption join", () => {
    const summary = summarizeGatewayPodReplacements(
      stored({
        recentAt: [NOW - HOUR],
        lastAt: NOW - HOUR,
        lastVacatedPodUid: "uid-a",
        lastVacatedNodeName: "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd",
        lastVacatedInstanceId: "7311234567890123456",
        lastVacatedNodePool: "nap-1dx2tv8d",
        total: 1,
      }),
      NOW,
    );
    expect(summary.lastVacatedNodeName)
      .toBe("gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd");
    expect(summary.lastVacatedInstanceId).toBe("7311234567890123456");
    expect(summary.lastVacatedNodePool).toBe("nap-1dx2tv8d");
  });

  it("keeps lastAt after the entry has aged out of the 7d window", () => {
    const summary = summarizeGatewayPodReplacements(
      stored({ lastAt: NOW - 30 * DAY, lastVacatedPodUid: "uid-old", total: 1 }),
      NOW,
    );
    expect(summary.count7d).toBe(0);
    expect(summary.lastAt).toBe(NOW - 30 * DAY);
    expect(summary.lastVacatedPodUid).toBe("uid-old");
  });

  it("ignores timestamps in the future rather than counting them", () => {
    const summary = summarizeGatewayPodReplacements(
      stored({ recentAt: [NOW + HOUR, NOW - HOUR], lastAt: NOW + HOUR, total: 2 }),
      NOW,
    );
    expect(summary.count24h).toBe(1);
    expect(summary.count7d).toBe(1);
  });

  it("warns at the 24h threshold and stays quiet below it", () => {
    const below = summarizeGatewayPodReplacements(
      stored({ recentAt: [NOW - HOUR, NOW - 2 * HOUR], lastAt: NOW - HOUR, total: 2 }),
      NOW,
    );
    expect(below.count24h).toBe(POD_REPLACEMENT_WARNING_THRESHOLD_24H - 1);
    expect(below.warn).toBe(false);

    const atThreshold = summarizeGatewayPodReplacements(
      stored({
        recentAt: [NOW - HOUR, NOW - 2 * HOUR, NOW - 3 * HOUR],
        lastAt: NOW - HOUR,
        total: 3,
      }),
      NOW,
    );
    expect(atThreshold.count24h).toBe(POD_REPLACEMENT_WARNING_THRESHOLD_24H);
    expect(atThreshold.warn).toBe(true);
  });
});

describe("isGatewayPodReplacements", () => {
  it("accepts a well-formed record", () => {
    expect(isGatewayPodReplacements(stored({
      recentAt: [NOW],
      lastAt: NOW,
      lastVacatedPodUid: "uid-a",
      lastVacatedNodeName: "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd",
      lastVacatedInstanceId: "7311234567890123456",
      lastVacatedNodePool: "nap-1dx2tv8d",
      total: 1,
    }))).toBe(true);
  });

  it("accepts a never-replaced record with null identity", () => {
    expect(isGatewayPodReplacements(stored())).toBe(true);
  });

  it.each([
    ["a non-object", "nope"],
    ["a missing window", { ...stored(), recentAt: undefined }],
    ["a non-numeric window entry", { ...stored(), recentAt: ["soon"] }],
    ["a negative total", { ...stored(), total: -1 }],
    ["a non-integer total", { ...stored(), total: 1.5 }],
    ["a numeric pod uid", { ...stored(), lastVacatedPodUid: 7 }],
    ["a numeric vacated instance id", { ...stored(), lastVacatedInstanceId: 42 }],
  ])("rejects %s", (_label, value) => {
    expect(isGatewayPodReplacements(value)).toBe(false);
  });
});
