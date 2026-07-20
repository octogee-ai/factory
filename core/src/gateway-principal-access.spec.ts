import { describe, expect, it } from "vitest";

import {
  GATEWAY_PERMISSION_SETS,
  gatewayAccessGrantId,
  resolveGatewayPrincipalAccess,
} from "./gateway-principal-access.js";

const gateway = {
  gatewayId: "bender",
  ownerUid: "owner",
  workspaceSlug: "alex",
};

function grant(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    gatewayId: "bender",
    workspaceSlug: "alex",
    ownerUid: "owner",
    granteeUid: "helper",
    permissionSetIds: ["trusted-helper.v1"],
    state: "active",
    revision: 3,
    expiresAt: null,
    ...overrides,
  };
}

describe("gateway principal access", () => {
  it("keeps the owner native without requiring a grant or membership", () => {
    expect(resolveGatewayPrincipalAccess({
      gateway,
      uid: "owner",
      grant: null,
      isWorkspaceMember: false,
      now: 1_000,
    })).toEqual(expect.objectContaining({
      kind: "owner",
      brokerProfile: "native-owner",
      dashboard: true,
      shell: true,
    }));
  });

  it.each([
    ["agent-viewer.v1", "delegated-read", false, false],
    ["trusted-helper.v1", "delegated-config", true, false],
    ["co-owner.v1", "native-co-owner", true, false],
    ["builder-shell.v1", null, false, true],
  ] as const)("resolves %s to its exact broker and capability profile", (
    permissionSetId,
    brokerProfile,
    config,
    shell,
  ) => {
    expect(resolveGatewayPrincipalAccess({
      gateway,
      uid: "helper",
      grant: grant({ permissionSetIds: [permissionSetId] }),
      isWorkspaceMember: true,
      now: 1_000,
    })).toEqual(expect.objectContaining({
      kind: "delegate",
      permissionSetIds: [permissionSetId],
      brokerProfile,
      dashboard: brokerProfile !== null,
      config,
      shell,
      grantRevision: 3,
    }));
  });

  it("does not bundle Builder Shell with Trusted Helper or Co-owner", () => {
    for (const permissionSetId of ["trusted-helper.v1", "co-owner.v1"] as const) {
      expect(resolveGatewayPrincipalAccess({
        gateway,
        uid: "helper",
        grant: grant({ permissionSetIds: [permissionSetId] }),
        isWorkspaceMember: true,
        now: 1_000,
      })).toEqual(expect.objectContaining({ shell: false }));
    }
  });

  it.each([
    [null, "grant_missing"],
    [grant({ state: "revoked" }), "grant_revoked"],
    [grant({ expiresAt: 999 }), "grant_expired"],
    [grant({ permissionSetIds: ["trusted-helper.v2"] }), "grant_invalid"],
    [grant({ permissionSetIds: [] }), "grant_invalid"],
    [grant({ gatewayId: "other" }), "grant_invalid"],
  ] as const)("fails closed for invalid grant state: %s", (candidate, reason) => {
    expect(resolveGatewayPrincipalAccess({
      gateway,
      uid: "helper",
      grant: candidate,
      isWorkspaceMember: true,
      now: 1_000,
    })).toEqual({ kind: "denied", reason });
  });

  it("denies an otherwise active grant immediately when membership is absent", () => {
    expect(resolveGatewayPrincipalAccess({
      gateway,
      uid: "helper",
      grant: grant(),
      isWorkspaceMember: false,
      now: 1_000,
    })).toEqual({ kind: "denied", reason: "membership_required" });
  });

  it("uses a stable collision-resistant document id", () => {
    expect(gatewayAccessGrantId("bender", "helper")).toMatch(/^[a-f0-9]{64}$/u);
    expect(gatewayAccessGrantId("ab", "c")).not.toBe(gatewayAccessGrantId("a", "bc"));
  });

  it("publishes complete versioned preset copy without internal RPC names", () => {
    expect(Object.keys(GATEWAY_PERMISSION_SETS)).toEqual([
      "agent-viewer.v1",
      "trusted-helper.v1",
      "co-owner.v1",
      "builder-shell.v1",
    ]);
    expect(JSON.stringify(GATEWAY_PERMISSION_SETS)).not.toMatch(/tools\.invoke|config\.patch|RPC/u);
  });
});
