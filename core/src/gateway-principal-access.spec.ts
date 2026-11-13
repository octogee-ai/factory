import { describe, expect, it } from "vitest";
import { resolveGatewayPrincipalAccess } from "./gateway-principal-access.js";

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

