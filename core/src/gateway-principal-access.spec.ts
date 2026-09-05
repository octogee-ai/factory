import { describe, expect, it } from "vitest";

import {
  GATEWAY_PERMISSION_SETS,
  workspaceAgentAccessGrantId,
  isCanonicalWorkspaceMembership,
  resolveGatewayPrincipalAccess,
} from "./gateway-principal-access.js";

const gateway = {
  gatewayId: "bender",
  ownerUid: "owner",
  workspaceSlug: "alex",
};

function grant(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
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
  it("accepts only a server-maintained Mattermost general-channel membership assertion", () => {
    expect(isCanonicalWorkspaceMembership({ role: "member" })).toBe(false);
    expect(isCanonicalWorkspaceMembership({
      role: "member",
      canonicalSource: "mattermost-general",
      canonicalState: "active",
      mattermostChannelId: "channel-1",
      mattermostUserId: "user-1",
    })).toBe(true);
    expect(isCanonicalWorkspaceMembership({
      role: "member",
      canonicalSource: "mattermost-general",
      canonicalState: "revoking",
      mattermostChannelId: "channel-1",
      mattermostUserId: "user-1",
    })).toBe(false);
  });

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
    }));
  });

  it.each([
    ["agent-viewer.v1", "delegated-read", false],
    ["trusted-helper.v1", "delegated-config", true],
    ["co-owner.v1", "native-co-owner", true],
  ] as const)("resolves %s to its exact broker and capability profile", (
    permissionSetId,
    brokerProfile,
    config,
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
      grantRevision: 3,
    }));
  });

  it.each([
    [null, "grant_missing"],
    [grant({ state: "revoked" }), "grant_revoked"],
    [grant({ expiresAt: 999 }), "grant_expired"],
    [grant({ permissionSetIds: ["trusted-helper.v2"] }), "grant_invalid"],
    [grant({ permissionSetIds: [] }), "grant_invalid"],
    [grant({ ownerUid: "other" }), "grant_invalid"],
    [grant({ workspaceSlug: "other" }), "grant_invalid"],
    [grant({ schemaVersion: 1 }), "grant_invalid"],
  ] as const)("fails closed for invalid grant state: %s", (candidate, reason) => {
    expect(resolveGatewayPrincipalAccess({
      gateway,
      uid: "helper",
      grant: candidate,
      isWorkspaceMember: true,
      now: 1_000,
    })).toEqual({ kind: "denied", reason });
  });

  it("keeps a workspace grant across gateway replacement without changing its expiry or revision", () => {
    expect(resolveGatewayPrincipalAccess({
      gateway: { ...gateway, gatewayId: "replacement" }, uid: "helper",
      grant: grant({ expiresAt: 2000 }), isWorkspaceMember: true, now: 1000,
    })).toMatchObject({ kind: "delegate", grantRevision: 3, expiresAt: 2000 });
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

  it("admits team members permanently without a support grant and keeps support elevation separate", () => {
    const input = { gateway: { ...gateway, teamAccess: true }, uid: "helper", isWorkspaceMember: true, now: 1000 };
    for (const candidate of [null, grant({ state: "revoked" }), grant({ expiresAt: 999 })]) {
      expect(resolveGatewayPrincipalAccess({ ...input, grant: candidate })).toMatchObject({
        kind: "member", brokerProfile: "native-member", expiresAt: null, config: false, grantRevision: null,
      });
    }
    expect(resolveGatewayPrincipalAccess({ ...input, grant: grant({ expiresAt: 2000 }) })).toMatchObject({
      kind: "delegate", brokerProfile: "native-member-helper", expiresAt: 2000, config: true,
    });
    expect(resolveGatewayPrincipalAccess({ ...input, grant: null, isWorkspaceMember: false })).toMatchObject({ kind: "denied" });
    expect(resolveGatewayPrincipalAccess({ ...input, gateway, grant: null })).toMatchObject({ kind: "denied" });
  });

  it("uses a stable collision-resistant document id", () => {
    expect(workspaceAgentAccessGrantId("owner", "alex", "helper")).toMatch(/^[a-f0-9]{64}$/u);
    expect(workspaceAgentAccessGrantId("ab", "c", "d")).not.toBe(
      workspaceAgentAccessGrantId("a", "bc", "d"),
    );
    expect(workspaceAgentAccessGrantId("owner", "alex", "helper")).not.toBe(
      workspaceAgentAccessGrantId("owner", "other-workspace", "helper"),
    );
  });

  it("publishes complete versioned preset copy without internal RPC names", () => {
    expect(Object.keys(GATEWAY_PERMISSION_SETS)).toEqual([
      "agent-viewer.v1",
      "trusted-helper.v1",
      "co-owner.v1",
    ]);
    expect(JSON.stringify(GATEWAY_PERMISSION_SETS)).not.toMatch(/tools\.invoke|config\.patch|RPC/u);
  });
});
