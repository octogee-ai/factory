import { describe, it, expect } from "vitest";
import {
  isValidGatewayId,
  operatorGatewayServiceAccountName,
  resolveGatewayClass,
  resolveGatewayImageProfile,
} from "./glm";

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

describe("gateway class/profile resolution", () => {
  it("keeps legacy profile=operator compatible for class and image", () => {
    expect(resolveGatewayClass({ profile: "operator" })).toBe("operator");
    expect(resolveGatewayImageProfile({ profile: "operator" })).toBe("operator");
  });

  it("defaults missing legacy profile to shared class + standard image", () => {
    expect(resolveGatewayClass({})).toBe("shared");
    expect(resolveGatewayImageProfile({})).toBe("standard");
  });

  it("derives the operator image from explicit operator class", () => {
    expect(resolveGatewayClass({ gatewayClass: "operator", profile: "standard" })).toBe("operator");
    expect(resolveGatewayImageProfile({ gatewayClass: "operator", profile: "standard" })).toBe("operator");
  });

  it("lets explicit imageProfile override the class-derived image", () => {
    expect(resolveGatewayImageProfile({ gatewayClass: "builder", imageProfile: "operator" })).toBe("operator");
    expect(resolveGatewayImageProfile({ gatewayClass: "operator", imageProfile: "standard" })).toBe("standard");
  });
});
