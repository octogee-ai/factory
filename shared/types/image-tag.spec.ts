import { describe, expect, it } from "vitest";
import { gatewayHeartbeatMatchesImageTag } from "./image-tag.js";

describe("gatewayHeartbeatMatchesImageTag", () => {
  it("matches the complete immutable artifact tag reported by current gateway images", () => {
    expect(gatewayHeartbeatMatchesImageTag(
      "cf36a88-oc2026.7.1",
      "cf36a88-oc2026.7.1",
    )).toBe(true);
  });

  it("matches a legacy build-SHA heartbeat to its OpenClaw-qualified artifact tag", () => {
    expect(gatewayHeartbeatMatchesImageTag("cf36a88", "cf36a88-oc2026.7.1")).toBe(true);
  });

  it("matches the tag-name heartbeat for a digest-pinned W9 artifact", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(gatewayHeartbeatMatchesImageTag(
      "agent-conversation-w9a-8c356bb1",
      `agent-conversation-w9a-8c356bb1@${digest}`,
    )).toBe(true);
  });

  it("rejects heartbeats from a different immutable artifact", () => {
    expect(gatewayHeartbeatMatchesImageTag(
      "cf36a89-oc2026.7.1",
      "cf36a88-oc2026.7.1",
    )).toBe(false);
  });
});
