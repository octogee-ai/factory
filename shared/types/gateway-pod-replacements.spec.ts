import { describe, expect, it } from "vitest";
import {
  POD_REPLACEMENT_WARNING_THRESHOLD_24H,
  isGatewayPodReplacements,
  summarizeGatewayPodReplacements,
} from "./gateway-pod-replacements";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_770_000_000_000;

describe("summarizeGatewayPodReplacements", () => {
  it("reports an empty summary when the gateway has never been tracked", () => {
    expect(summarizeGatewayPodReplacements(null, NOW)).toEqual({
      count24h: 0,
      count7d: 0,
      lastAt: null,
      lastPodUid: null,
      total: 0,
      warn: false,
    });
  });

  it("counts only replacements inside each rolling window", () => {
    const summary = summarizeGatewayPodReplacements(
      {
        recentAt: [NOW - 6 * DAY, NOW - 2 * DAY, NOW - 3 * HOUR, NOW - HOUR],
        lastAt: NOW - HOUR,
        lastPodUid: "uid-d",
        total: 9,
      },
      NOW,
    );
    expect(summary.count24h).toBe(2);
    expect(summary.count7d).toBe(4);
    expect(summary.total).toBe(9);
    expect(summary.lastPodUid).toBe("uid-d");
  });

  it("keeps lastAt after the entry has aged out of the 7d window", () => {
    const summary = summarizeGatewayPodReplacements(
      { recentAt: [], lastAt: NOW - 30 * DAY, lastPodUid: "uid-old", total: 1 },
      NOW,
    );
    expect(summary.count7d).toBe(0);
    expect(summary.lastAt).toBe(NOW - 30 * DAY);
    expect(summary.lastPodUid).toBe("uid-old");
  });

  it("ignores timestamps in the future rather than counting them", () => {
    const summary = summarizeGatewayPodReplacements(
      { recentAt: [NOW + HOUR, NOW - HOUR], lastAt: NOW + HOUR, lastPodUid: "uid-a", total: 2 },
      NOW,
    );
    expect(summary.count24h).toBe(1);
    expect(summary.count7d).toBe(1);
  });

  it("warns at the 24h threshold and stays quiet below it", () => {
    const below = summarizeGatewayPodReplacements(
      { recentAt: [NOW - HOUR, NOW - 2 * HOUR], lastAt: NOW - HOUR, lastPodUid: "u", total: 2 },
      NOW,
    );
    expect(below.count24h).toBe(POD_REPLACEMENT_WARNING_THRESHOLD_24H - 1);
    expect(below.warn).toBe(false);

    const atThreshold = summarizeGatewayPodReplacements(
      {
        recentAt: [NOW - HOUR, NOW - 2 * HOUR, NOW - 3 * HOUR],
        lastAt: NOW - HOUR,
        lastPodUid: "u",
        total: 3,
      },
      NOW,
    );
    expect(atThreshold.count24h).toBe(POD_REPLACEMENT_WARNING_THRESHOLD_24H);
    expect(atThreshold.warn).toBe(true);
  });
});

describe("isGatewayPodReplacements", () => {
  it("accepts a well-formed record", () => {
    expect(isGatewayPodReplacements({
      recentAt: [NOW],
      lastAt: NOW,
      lastPodUid: "uid-a",
      total: 1,
    })).toBe(true);
  });

  it("accepts a never-replaced record with null identity", () => {
    expect(isGatewayPodReplacements({
      recentAt: [],
      lastAt: null,
      lastPodUid: null,
      total: 0,
    })).toBe(true);
  });

  it.each([
    ["a non-object", "nope"],
    ["a missing window", { lastAt: null, lastPodUid: null, total: 0 }],
    ["a non-numeric window entry", {
      recentAt: ["soon"], lastAt: null, lastPodUid: null, total: 0,
    }],
    ["a negative total", { recentAt: [], lastAt: null, lastPodUid: null, total: -1 }],
    ["a non-integer total", { recentAt: [], lastAt: null, lastPodUid: null, total: 1.5 }],
    ["a numeric pod uid", { recentAt: [], lastAt: null, lastPodUid: 7, total: 0 }],
  ])("rejects %s", (_label, value) => {
    expect(isGatewayPodReplacements(value)).toBe(false);
  });
});
