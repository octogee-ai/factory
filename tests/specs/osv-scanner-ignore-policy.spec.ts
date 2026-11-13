import { describe, expect, it } from "vitest";
import {
  MAX_IGNORE_WINDOW_DAYS,
  validateIgnorePolicyFile,
} from "../../scripts/lib/osv-scanner-ignore-policy.js";

const referenceDate = new Date("2026-07-24T00:00:00Z");

describe("osv-scanner ignore policy", () => {
  it("rejects an entry missing an id", () => {
    const toml = [
      "[[IgnoredVulns]]",
      'ignoreUntil = 2026-08-24',
      'reason = "tracking #1"',
    ].join("\n");

    const violations = validateIgnorePolicyFile(toml, referenceDate);

    expect(violations.some((v) => v.message.includes("id"))).toBe(true);
  });

  it("rejects an entry whose reason has no issue reference", () => {
    const toml = [
      "[[IgnoredVulns]]",
      'id = "GHSA-xxxx-xxxx-xxxx"',
      'ignoreUntil = 2026-08-24',
      'reason = "no tracking reference here"',
    ].join("\n");

    const violations = validateIgnorePolicyFile(toml, referenceDate);

    expect(violations.some((v) => v.message.includes("issue reference"))).toBe(true);
  });

  it("rejects an entry whose ignoreUntil exceeds the policy's maximum window", () => {
    const tooFar = new Date(referenceDate);
    tooFar.setUTCDate(tooFar.getUTCDate() + MAX_IGNORE_WINDOW_DAYS + 1);
    const tooFarDate = tooFar.toISOString().slice(0, 10);
    const toml = [
      "[[IgnoredVulns]]",
      'id = "GHSA-xxxx-xxxx-xxxx"',
      `ignoreUntil = ${tooFarDate}`,
      'reason = "tracking #1"',
    ].join("\n");

    const violations = validateIgnorePolicyFile(toml, referenceDate);

    expect(violations.some((v) => v.message.includes(`${MAX_IGNORE_WINDOW_DAYS} days`))).toBe(true);
  });

  it("accepts an entry with an ignoreUntil inside the policy's maximum window", () => {
    const withinWindow = new Date(referenceDate);
    withinWindow.setUTCDate(withinWindow.getUTCDate() + MAX_IGNORE_WINDOW_DAYS - 1);
    const withinWindowDate = withinWindow.toISOString().slice(0, 10);
    const toml = [
      "[[IgnoredVulns]]",
      'id = "GHSA-xxxx-xxxx-xxxx"',
      `ignoreUntil = ${withinWindowDate}`,
      'reason = "tracking #1"',
    ].join("\n");

    const violations = validateIgnorePolicyFile(toml, referenceDate);

    expect(violations).toEqual([]);
  });
});
