import { describe, it, expect } from "vitest";
import {
  defaultOperatorGatewayAccess,
  isValidGatewayId,
  operatorGatewayServiceAccountName,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  resolveUserGatewayShellState,
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

describe("defaultOperatorGatewayAccess", () => {
  it("grants shells to an owned runtime gateway and locks an un-owned one", () => {
    expect(defaultOperatorGatewayAccess("uid-chris")).toMatchObject({ shellsEnabled: true });
    expect(defaultOperatorGatewayAccess(null)).toMatchObject({ shellsEnabled: false });
    expect(defaultOperatorGatewayAccess(undefined)).toMatchObject({ shellsEnabled: false });
  });
});

describe("resolveUserGatewayShellState", () => {
  it("enables BuilderShell for the owner of an operator-class gateway with shells on", () => {
    expect(
      resolveUserGatewayShellState(
        {
          gatewayClass: "operator",
          imageProfile: "operator",
          ownerUid: "uid-chris",
          operatorAccess: { shellsEnabled: true },
        },
        "uid-chris",
      ),
    ).toEqual({ gatewayProfile: "operator", shellsEnabled: true });
  });

  it("enables BuilderShell for the owner of a builder-class gateway with shells on", () => {
    expect(
      resolveUserGatewayShellState(
        {
          gatewayClass: "builder",
          imageProfile: "standard",
          ownerUid: "uid-chris",
          operatorAccess: { shellsEnabled: true },
        },
        "uid-chris",
      ),
    ).toEqual({ gatewayProfile: "standard", shellsEnabled: true });
  });

  it("honors a co-owner", () => {
    expect(
      resolveUserGatewayShellState(
        { gatewayClass: "operator", coOwnerUids: ["uid-jack"], operatorAccess: { shellsEnabled: true } },
        "uid-jack",
      ).shellsEnabled,
    ).toBe(true);
  });

  it("denies a guest migrated onto someone else's operator gateway", () => {
    expect(
      resolveUserGatewayShellState(
        { gatewayClass: "operator", ownerUid: "uid-bender", operatorAccess: { shellsEnabled: true } },
        "uid-jack",
      ),
    ).toEqual({ gatewayProfile: "operator", shellsEnabled: false });
  });

  it("never enables shells on a shared gateway", () => {
    expect(
      resolveUserGatewayShellState({ gatewayClass: "shared", ownerUid: "uid-chris" }, "uid-chris"),
    ).toEqual({ gatewayProfile: "standard", shellsEnabled: false });
  });

  it("respects an explicitly locked operatorAccess even for the owner", () => {
    expect(
      resolveUserGatewayShellState(
        { gatewayClass: "operator", ownerUid: "uid-chris", operatorAccess: { shellsEnabled: false } },
        "uid-chris",
      ).shellsEnabled,
    ).toBe(false);
  });
});
