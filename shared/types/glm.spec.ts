import { describe, it, expect } from "vitest";
import { isValidGatewayId, operatorGatewayServiceAccountName } from "./glm";

describe("operatorGatewayServiceAccountName", () => {
  it("prefixes the bare gateway id with the operator KSA prefix", () => {
    expect(operatorGatewayServiceAccountName("bender")).toBe("octogee-gw-bender");
    expect(operatorGatewayServiceAccountName("default")).toBe("octogee-gw-default");
  });

  it("uses the gateway id verbatim — ids are bare, no prefix manipulation", () => {
    expect(operatorGatewayServiceAccountName("mountain-mama")).toBe(
      "octogee-gw-mountain-mama",
    );
  });
});

describe("isValidGatewayId", () => {
  it("accepts bare gateway identities that fit rendered Kubernetes resource names", () => {
    expect(isValidGatewayId("default")).toBe(true);
    expect(isValidGatewayId("bender")).toBe(true);
    expect(isValidGatewayId("mountain-mama")).toBe(true);
    expect(isValidGatewayId("g")).toBe(true);
    expect(isValidGatewayId("a".repeat(32))).toBe(true);
  });

  it("rejects values that would break routing, secrets, or Kubernetes names", () => {
    for (const bad of [
      "",
      "Bender",
      "gw_test",
      "-bender",
      "bender-",
      "has space",
      "gw/evil",
      "../x",
      "a".repeat(33),
      undefined,
      123,
    ]) {
      expect(isValidGatewayId(bad)).toBe(false);
    }
  });
});
