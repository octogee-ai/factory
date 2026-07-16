import { describe, expect, it } from "vitest";

import { revisionIdFromGatewayPodName } from "./gateway-pod-revision.js";

describe("revisionIdFromGatewayPodName", () => {
  it("derives the immutable revision from the authenticated Deployment pod name", () => {
    expect(revisionIdFromGatewayPodName(
      "default",
      "octogee-gateway-default-r27-5bc5949d46-p946t",
    )).toBe("default-r27");
  });

  it("refuses ambiguous, cross-gateway, malformed, and unbounded pod identities", () => {
    expect(revisionIdFromGatewayPodName("default", undefined)).toBeNull();
    expect(revisionIdFromGatewayPodName("default", "octogee-gateway-default-r27")).toBeNull();
    expect(revisionIdFromGatewayPodName(
      "default",
      "octogee-gateway-other-r27-5bc5949d46-p946t",
    )).toBeNull();
    expect(revisionIdFromGatewayPodName(
      "default",
      "octogee-gateway-default-r027-5bc5949d46-p946t",
    )).toBeNull();
    expect(revisionIdFromGatewayPodName(
      "default",
      `octogee-gateway-default-r${"9".repeat(20)}-5bc5949d46-p946t`,
    )).toBeNull();
  });
});
