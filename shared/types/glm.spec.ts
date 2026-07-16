import { describe, it, expect } from "vitest";
import {
  defaultOperatorGatewayAccess,
  deriveGatewayIdentity,
  isValidGatewayId,
  isValidNewGatewayId,
  operatorGatewayServiceAccountName,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  resolveUserGatewayShellState,
  isGatewayClassControlUiAccessEnabled,
} from "./glm";

describe("deriveGatewayIdentity", () => {
  it("uses the explicit gateway field when present", () => {
    expect(deriveGatewayIdentity("default-blue", "default")).toBe("default");
    expect(deriveGatewayIdentity("bender", "bender")).toBe("bender");
  });

  it("ignores a non-string explicit value and falls back to convention-parse", () => {
    expect(deriveGatewayIdentity("default-blue", undefined)).toBe("default");
    expect(deriveGatewayIdentity("default-blue", null)).toBe("default");
    expect(deriveGatewayIdentity("default-blue", 42)).toBe("default");
  });

  it("strips a trailing -blue or -green roll-role suffix by convention", () => {
    expect(deriveGatewayIdentity("default-blue")).toBe("default");
    expect(deriveGatewayIdentity("default-green")).toBe("default");
  });

  it("treats an id without a roll-role suffix as its own bare identity", () => {
    expect(deriveGatewayIdentity("bender")).toBe("bender");
    expect(deriveGatewayIdentity("jack")).toBe("jack");
  });

  it("does not strip -blue/-green from the middle of an id, only a trailing suffix", () => {
    expect(deriveGatewayIdentity("blue-team")).toBe("blue-team");
    expect(deriveGatewayIdentity("green-house")).toBe("green-house");
  });
});

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

describe("isValidNewGatewayId", () => {
  it("accepts ordinary bare identities", () => {
    expect(isValidNewGatewayId("default")).toBe(true);
    expect(isValidNewGatewayId("bender")).toBe(true);
    expect(isValidNewGatewayId("mountain-mama")).toBe(true);
  });

  it("rejects ids ending in the reserved -blue/-green roll-role suffixes — they would mis-group under the convention fallback", () => {
    expect(isValidNewGatewayId("team-blue")).toBe(false);
    expect(isValidNewGatewayId("team-green")).toBe(false);
    expect(isValidNewGatewayId("default-blue")).toBe(false);
  });

  it("still allows the words blue/green anywhere but as a trailing roll-role suffix", () => {
    expect(isValidNewGatewayId("blue-team")).toBe(true);
    expect(isValidNewGatewayId("bluegreen")).toBe(true);
    expect(isValidNewGatewayId("blue")).toBe(true);
    expect(isValidNewGatewayId("green")).toBe(true);
  });

  it("keeps every base isValidGatewayId rejection", () => {
    for (const bad of ["", "Bender", "-bender", "a".repeat(33), undefined, 123]) {
      expect(isValidNewGatewayId(bad)).toBe(false);
    }
  });

  it("existing suffixed INSTANCE ids stay valid for routing/rollout — only new-gateway creation reserves the suffix", () => {
    expect(isValidGatewayId("default-blue")).toBe(true);
    expect(isValidGatewayId("default-green")).toBe(true);
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

describe("isGatewayClassControlUiAccessEnabled", () => {
  it("requires an isolated class plus shell and Control UI entitlements", () => {
    expect(isGatewayClassControlUiAccessEnabled("builder", {
      shellsEnabled: true,
      controlUiEnabled: true,
    })).toBe(true);
    expect(isGatewayClassControlUiAccessEnabled("operator", {
      shellsEnabled: true,
      controlUiEnabled: true,
    })).toBe(true);
    expect(isGatewayClassControlUiAccessEnabled("shared", {
      shellsEnabled: true,
      controlUiEnabled: true,
    })).toBe(false);
    expect(isGatewayClassControlUiAccessEnabled("builder", {
      shellsEnabled: false,
      controlUiEnabled: true,
    })).toBe(false);
    expect(isGatewayClassControlUiAccessEnabled("operator", {
      shellsEnabled: true,
      controlUiEnabled: false,
    })).toBe(false);
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
