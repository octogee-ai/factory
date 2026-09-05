import { describe, it, expect } from "vitest";
import {
  GATEWAY_CLASSES,
  defaultBuilderGatewayAccess,
  deriveGatewayIdentity,
  BUILDER_GATEWAY_LOCKED_ACCESS,
  isValidGatewayId,
  isValidNewGatewayId,
  builderGatewayServiceAccountName,
  gatewayVmInstanceName,
  isGatewayRuntime,
  resolveGatewayRuntime,
  resolveGatewayClass,
  resolveGatewayImageProfile,
  resolveUserGatewayControlState,
  isGatewayClassControlUiAccessEnabled,
  isGatewayControlIdentity,
  resolveGatewayControlIdentity,
  isOperatorManaged,
  resolveManagedBy,
  resolveOperationOrigin,
  isOperationAuditRecord,
  isOperationAuditRow,
  OPERATION_AUDIT_RECORD_TYPE,
  OPERATION_AUDIT_SCHEMA_VERSION,
} from "./glm";

describe("managedBy ownership", () => {
  it("defaults absent and invalid values to Cowboy while recognizing an operator override", () => {
    expect(resolveManagedBy(undefined)).toBe("cowboy");
    expect(resolveManagedBy("unknown")).toBe("cowboy");
    expect(resolveManagedBy("operator")).toBe("operator");
    expect(isOperatorManaged(undefined)).toBe(false);
    expect(isOperatorManaged("operator")).toBe(true);
  });

  it("treats operations without an origin as manual", () => {
    expect(resolveOperationOrigin(undefined)).toBe("operator");
    expect(resolveOperationOrigin("operator")).toBe("operator");
    expect(resolveOperationOrigin("automatic")).toBe("automatic");
  });
});

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

describe("builderGatewayServiceAccountName", () => {
  it("prefixes the bare gateway id with the Builder KSA prefix", () => {
    expect(builderGatewayServiceAccountName("bender")).toBe("octogee-gw-bender");
    expect(builderGatewayServiceAccountName("default")).toBe("octogee-gw-default");
  });

  it("uses the gateway id verbatim — ids are bare, no prefix manipulation", () => {
    expect(builderGatewayServiceAccountName("mountain-mama")).toBe(
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
  it("exposes exactly the Barn and disposable Builder customer classes", () => {
    expect(GATEWAY_CLASSES).toEqual(["shared", "builder"]);
  });

  it("does not infer a customer class from a legacy runtime profile", () => {
    expect(resolveGatewayClass({ profile: "operator" as never })).toBe("shared");
  });

  it("fails stale customer class and image values closed at runtime", () => {
    expect(resolveGatewayClass({ gatewayClass: "operator" as never })).toBe("shared");
    expect(resolveGatewayImageProfile({ imageProfile: "operator" as never })).toBe("standard");
  });

  it("defaults missing legacy profile to shared class + standard image", () => {
    expect(resolveGatewayClass({})).toBe("shared");
    expect(resolveGatewayImageProfile({})).toBe("standard");
  });

  it("maps the Builder class to its Builder image profile", () => {
    expect(resolveGatewayClass({ gatewayClass: "builder", profile: "standard" })).toBe("builder");
    expect(resolveGatewayImageProfile({ gatewayClass: "builder", profile: "standard" })).toBe("builder");
  });

  it("lets explicit imageProfile override the class-derived image", () => {
    expect(resolveGatewayImageProfile({ gatewayClass: "builder", imageProfile: "builder" })).toBe("builder");
    expect(resolveGatewayImageProfile({ gatewayClass: "shared", imageProfile: "standard" })).toBe("standard");
  });
});

describe("defaultBuilderGatewayAccess", () => {
  it("grants Control UI to an owned runtime gateway and locks an un-owned one", () => {
    expect(defaultBuilderGatewayAccess("uid-chris")).toEqual({
      controlUiEnabled: true,
      reason: "owned-runtime-gateway",
    });
    expect(defaultBuilderGatewayAccess(null)).toEqual(BUILDER_GATEWAY_LOCKED_ACCESS);
    expect(defaultBuilderGatewayAccess(undefined)).toEqual(BUILDER_GATEWAY_LOCKED_ACCESS);
  });
});

describe("isGatewayClassControlUiAccessEnabled", () => {
  it("requires explicitly enabled Control UI on isolated classes", () => {
    expect(isGatewayClassControlUiAccessEnabled("builder", {
      controlUiEnabled: true,
    })).toBe(true);
    expect(isGatewayClassControlUiAccessEnabled("shared", {
      controlUiEnabled: true,
    })).toBe(false);
    expect(isGatewayClassControlUiAccessEnabled("builder", {
      controlUiEnabled: true,
    })).toBe(true);
    expect(isGatewayClassControlUiAccessEnabled("builder", {})).toBe(false);
    expect(isGatewayClassControlUiAccessEnabled("builder", {
      controlUiEnabled: false,
    })).toBe(false);
  });
});

describe("resolveUserGatewayControlState", () => {
  it("does not infer Control UI from the retired operator image profile", () => {
    expect(
      resolveUserGatewayControlState(
        {
          gatewayClass: "shared",
          imageProfile: "operator",
          ownerUid: "uid-chris",
          builderAccess: { controlUiEnabled: true },
        },
        "uid-chris",
      ),
    ).toEqual({ gatewayProfile: "standard", controlUiEnabled: false });
  });

  it("enables Control UI for the owner of an explicitly enabled builder gateway", () => {
    expect(
      resolveUserGatewayControlState(
        {
          gatewayClass: "builder",
          imageProfile: "standard",
          ownerUid: "uid-chris",
          builderAccess: { controlUiEnabled: true },
        },
        "uid-chris",
      ),
    ).toEqual({ gatewayProfile: "builder", controlUiEnabled: true });
  });

  it("does not grant Control UI to a non-owner", () => {
    expect(
      resolveUserGatewayControlState(
        { gatewayClass: "builder", ownerUid: "uid-bender", builderAccess: { controlUiEnabled: true } },
        "uid-jack",
      ).controlUiEnabled,
    ).toBe(false);
  });

  it("denies Control UI to a guest migrated onto someone else's Builder gateway", () => {
    expect(
      resolveUserGatewayControlState(
        { gatewayClass: "builder", ownerUid: "uid-bender", builderAccess: { controlUiEnabled: true } },
        "uid-jack",
      ),
    ).toEqual({ gatewayProfile: "builder", controlUiEnabled: false });
  });

  it("never enables Control UI on a shared gateway", () => {
    expect(
      resolveUserGatewayControlState({ gatewayClass: "shared", ownerUid: "uid-chris" }, "uid-chris"),
    ).toEqual({ gatewayProfile: "standard", controlUiEnabled: false });
  });

  it("respects explicitly locked Builder access even for the owner", () => {
    expect(
      resolveUserGatewayControlState(
        { gatewayClass: "builder", ownerUid: "uid-chris", builderAccess: { controlUiEnabled: false } },
        "uid-chris",
      ).controlUiEnabled,
    ).toBe(false);
  });
});

describe("operation audit record discriminator", () => {
  const valid = {
      recordType: OPERATION_AUDIT_RECORD_TYPE,
      schemaVersion: OPERATION_AUDIT_SCHEMA_VERSION,
      status: "recorded",
      lifecycleStage: "intent-recorded",
      idempotencyKey: "release-v1",
      mutationFingerprint: "abc123",
      mutation: { action: "move-alias" },
      actor: "fleet-cli:operator",
      forced: true,
      what: "move alias",
      why: "TEST verified",
      target: { alias: "stable" },
      preActionStatus: { target: "old" },
      aliasPlan: [],
      createdAt: 1,
      completedAt: null,
    };

  it("recognizes a complete current-schema audit without treating commands as audits", () => {
    expect(isOperationAuditRecord(valid)).toBe(true);
    expect(isOperationAuditRecord({ kind: "rollout", status: "pending" })).toBe(false);
    expect(isOperationAuditRecord(null)).toBe(false);
  });

  it("quarantines malformed and future audit rows by discriminator while rejecting their schema", () => {
    for (const row of [
      { ...valid, schemaVersion: 2 },
      { ...valid, actor: undefined },
      { ...valid, mutation: [] },
      { ...valid, status: "completed", lifecycleStage: "intent-recorded" },
    ]) {
      expect(isOperationAuditRow(row)).toBe(true);
      expect(isOperationAuditRecord(row)).toBe(false);
    }
  });

  it("accepts only legal status and lifecycle pairs with their required claim and outcome fields", () => {
    expect(isOperationAuditRecord({
      ...valid,
      status: "in-progress",
      lifecycleStage: "action-started",
      actionClaimId: "runner-1",
      actionStartedAt: 2,
      actionRecoveryCount: 0,
    })).toBe(true);
    expect(isOperationAuditRecord({
      ...valid,
      status: "completed",
      lifecycleStage: "action-completed",
      actionClaimId: "runner-1",
      actionStartedAt: 2,
      actionRecoveryCount: 0,
      outcome: "completed",
      completedAt: 3,
    })).toBe(true);
    expect(isOperationAuditRecord({
      ...valid,
      status: "completed",
      lifecycleStage: "action-completed",
      outcome: "completed",
      completedAt: 3,
    })).toBe(false);
  });
});

describe("gateway control identity", () => {
  it("defaults every absent or unknown value to the shared operator identity", () => {
    expect(resolveGatewayControlIdentity(undefined)).toBe("shared-operator");
    expect(resolveGatewayControlIdentity(null)).toBe("shared-operator");
    expect(resolveGatewayControlIdentity("trusted-proxy")).toBe("shared-operator");
    expect(resolveGatewayControlIdentity("per-user")).toBe("per-user");
  });

  it("recognizes only the two declared modes", () => {
    expect(isGatewayControlIdentity("shared-operator")).toBe(true);
    expect(isGatewayControlIdentity("per-user")).toBe(true);
    expect(isGatewayControlIdentity("Per-User")).toBe(false);
    expect(isGatewayControlIdentity(true)).toBe(false);
  });
});

describe("gateway runtime + VM naming", () => {
  it("defaults an unknown runtime to cluster and accepts gce-vm", () => {
    expect(resolveGatewayRuntime(undefined)).toBe("cluster");
    expect(resolveGatewayRuntime("nope")).toBe("cluster");
    expect(resolveGatewayRuntime("gce-vm")).toBe("gce-vm");
    expect(isGatewayRuntime("cluster")).toBe(true);
    expect(isGatewayRuntime("local")).toBe(false);
  });

  it("derives a GCE instance name from the gateway id", () => {
    expect(gatewayVmInstanceName("b-mama-3-abc-hobby")).toBe("octogee-gw-b-mama-3-abc-hobby");
    expect(gatewayVmInstanceName("Shared_A")).toBe("octogee-gw-shared-a");
    expect(gatewayVmInstanceName("  x  ")).toBe("octogee-gw-x");
  });

  it("keeps long ids within the 63-character GCE limit with a stable hash suffix", () => {
    const longId = `b-${"mountain-mama-".repeat(6)}7-lease-pro`;
    const name = gatewayVmInstanceName(longId);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^octogee-gw-[a-z0-9-]+-[0-9a-f]{8}$/);
    expect(gatewayVmInstanceName(longId)).toBe(name);
    expect(gatewayVmInstanceName(`${longId}-x`)).not.toBe(name);
  });

  it("refuses an id with nothing to name", () => {
    expect(() => gatewayVmInstanceName("")).toThrow(/empty/);
    expect(() => gatewayVmInstanceName("___")).toThrow(/no usable characters/);
  });
});
