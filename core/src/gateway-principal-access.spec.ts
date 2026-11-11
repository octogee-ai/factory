import { describe, expect, it } from "vitest";
import { resolveGatewayPrincipalAccess, workspacePermissionsEnabled } from "./gateway-principal-access.js";

const gateway = { gatewayId: "alice-gateway", ownerUid: "alice", workspaceSlug: "alice", perUserIdentity: true };
const member = { id: "bob", role: "member", canonicalSource: "mattermost-general", canonicalState: "active", mattermostChannelId: "general", mattermostUserId: "mm-bob" };
const resolve = (membership: unknown, uid = "bob") => resolveGatewayPrincipalAccess({ gateway, uid, membership });

describe("workspace gateway membership", () => {
  it("gives every active workspace member Dashboard access without a grant", () => {
    expect(resolve(member)).toMatchObject({ kind: "member",  dashboard: true });
  });
  it("does not interpret membership role fields as OpenClaw permissions", () => {
    expect(resolve({ ...member, role: "admin" })).toMatchObject({ kind: "member",  dashboard: true });
  });
  it("keeps Dashboard access when an Admin becomes a Member", () => {
    expect(resolve({ ...member, role: "admin" })).toEqual(resolve(member));
    expect(resolve(member)).toMatchObject({  dashboard: true });
  });
  it("admits the workspace owner independently of guest membership", () => {
    expect(resolve(null, "alice")).toMatchObject({ kind: "owner",  dashboard: true });
  });
  it.each([null, { ...member, canonicalState: "revoking" }, { ...member, canonicalState: "pending" }, { ...member, mattermostUserId: "" }, { ...member, mattermostChannelId: "" }])("denies missing or invalid membership", (membership) => {
    expect(resolve(membership)).toMatchObject({ kind: "denied" });
  });
  it("denies members on a gateway without per-user identity", () => {
    expect(resolveGatewayPrincipalAccess({ gateway: { ...gateway, perUserIdentity: false }, uid: "bob", membership: member })).toMatchObject({ kind: "denied" });
  });
  it("does not authorize access to an unowned gateway", () => {
    expect(resolveGatewayPrincipalAccess({ gateway: { ...gateway, ownerUid: null }, uid: "bob", membership: member })).toMatchObject({ kind: "denied" });
  });
});


describe("User workspace permission availability", () => {
  const config = { gatewayClass: "builder", builderAccess: { controlIdentity: "per-user" } };
  const paid = { builderSubscription: { tier: "hobby", status: "active" } };
  const now = new Date("2026-09-15");
  it("admits paid and active-trial users, and excludes free, expired, shared, and shared-identity gateways", () => {
    const trialGrant = { schemaVersion: 3, offerId: "builder-signup", offerVersion: 1, personalTier: "personal", builderTier: "hobby",
      configHash: "trial", claimedAt: new Date("2026-09-14"), endsAt: new Date("2026-09-20") };
    expect(workspacePermissionsEnabled(config, paid, now)).toBe(true);
    expect(workspacePermissionsEnabled(config, { trialGrant }, now)).toBe(true);
    expect(workspacePermissionsEnabled(config, { trialGrant: { ...trialGrant, endsAt: new Date("2026-09-14") } }, now)).toBe(false);
    expect(workspacePermissionsEnabled(config, {}, now)).toBe(false);
    expect(workspacePermissionsEnabled({ ...config, gatewayClass: "shared" }, paid, now)).toBe(false);
    expect(workspacePermissionsEnabled({ ...config, builderAccess: { controlIdentity: "shared-operator" } }, paid, now)).toBe(false);
  });
});
