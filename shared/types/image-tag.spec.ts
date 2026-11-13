import { describe, expect, it } from "vitest";
import { gatewayHeartbeatMatchesImageTag } from "./image-tag.js";

describe("gatewayHeartbeatMatchesImageTag", () => {
  it("matches the complete immutable artifact tag reported by current gateway images", () => {
    expect(gatewayHeartbeatMatchesImageTag(
      "cf36a88-oc2026.7.1",
      "cf36a88-oc2026.7.1",
    )).toBe(true);
  });

  it("rejects an ambiguous legacy build-SHA heartbeat for an OpenClaw-qualified tag", () => {
    expect(gatewayHeartbeatMatchesImageTag("cf36a88", "cf36a88-oc2026.7.1")).toBe(false);
  });

  it("matches the tag-name heartbeat for a digest-pinned artifact", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(gatewayHeartbeatMatchesImageTag(
      "cf36a88-oc2026.7.1",
      `cf36a88-oc2026.7.1@${digest}`,
    )).toBe(true);
  });

  it("rejects heartbeats from a different immutable artifact", () => {
    expect(gatewayHeartbeatMatchesImageTag(
      "cf36a89-oc2026.7.1",
      "cf36a88-oc2026.7.1",
    )).toBe(false);
  });
});
