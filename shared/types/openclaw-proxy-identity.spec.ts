import { describe, expect, it } from "vitest";

import { deriveDeviceIdentity, generateIdentity } from "./device-identity";
import {
  OPENCLAW_EDGE_SERVICE_IDENTITY,
  OPENCLAW_FULL_OPERATOR_SCOPES,
  OPENCLAW_OPERATOR_ROLES,
  OPENCLAW_PROVISIONER_SERVICE_IDENTITY,
  OPENCLAW_PROXY_ATTESTATION_HEADER,
  OPENCLAW_PROXY_USER_HEADER,
  OPENCLAW_TRUSTED_PROXY_AUTH,
  isOpenClawProxyIdentityHeader,
  isPerUserControlIdentity,
  openClawRoleScopes,
  openClawDeviceSubject,
  openClawIdentityScopes,
  openClawOperatorRoles,
  openClawProxyIdentityHeaders,
  resolveControlIdentityFromEnv,
  resolveOwnerUidFromEnv,
  serviceProxyIdentity,
} from "./openclaw-proxy-identity";

describe("OpenClaw proxy identity contract", () => {
  it("limits ordinary Team members to the workspace coach and their own sessions", () => {
    const roles = openClawOperatorRoles("ceckert-test");
    expect(roles.definitions.member).toEqual({
      sessions: { others: "none" }, agents: ["octogee-ceckert-test-coach"],
      scopes: ["operator.read", "operator.write", "operator.questions"],
    });
    expect(openClawOperatorRoles().definitions.member.agents).toEqual([]);
    expect(roles.definitions.member.scopes).not.toContain("operator.admin");
  });
  it("activates only on the explicit per-user environment value", () => {
    expect(resolveControlIdentityFromEnv({})).toBe("shared-operator");
    expect(resolveControlIdentityFromEnv({ OPENCLAW_CONTROL_IDENTITY: "per-user" })).toBe("per-user");
    expect(resolveControlIdentityFromEnv({ OPENCLAW_CONTROL_IDENTITY: " per-user " })).toBe("per-user");
    expect(isPerUserControlIdentity({ OPENCLAW_CONTROL_IDENTITY: "trusted-proxy" })).toBe(false);
    expect(resolveOwnerUidFromEnv({ GATEWAY_OWNER_UID: " uid-owner " })).toBe("uid-owner");
    expect(resolveOwnerUidFromEnv({})).toBeUndefined();
  });

  it("mints the user and attestation headers the gateway is configured to trust", () => {
    const headers = openClawProxyIdentityHeaders({ user: "uid-Alice", clientAddress: "10.4.2.9" });
    expect(headers[OPENCLAW_PROXY_USER_HEADER]).toBe("uid-Alice");
    expect(headers[OPENCLAW_PROXY_ATTESTATION_HEADER]).toBe("1");
    expect(headers["x-forwarded-for"]).toBe("10.4.2.9");
    expect(headers["x-forwarded-proto"]).toBe("https");
    expect(OPENCLAW_TRUSTED_PROXY_AUTH.trustedProxy.userHeader).toBe(OPENCLAW_PROXY_USER_HEADER);
    expect(OPENCLAW_TRUSTED_PROXY_AUTH.trustedProxy.requiredHeaders)
      .toEqual([OPENCLAW_PROXY_ATTESTATION_HEADER]);
  });

  it("refuses an identity that could smuggle a second header line", () => {
    expect(() => openClawProxyIdentityHeaders({ user: "" })).toThrow(/single non-empty header line/);
    expect(() => openClawProxyIdentityHeaders({ user: "uid\r\nx-octogee-proxy: 1" }))
      .toThrow(/single non-empty header line/);
  });

  it("names services with a fixed prefix the grant lookup can never collide with", () => {
    expect(serviceProxyIdentity("gateway-edge")).toBe(OPENCLAW_EDGE_SERVICE_IDENTITY);
    expect(serviceProxyIdentity("octogee-provisioner")).toBe(OPENCLAW_PROVISIONER_SERVICE_IDENTITY);
    expect(() => serviceProxyIdentity("Gateway Edge")).toThrow(/invalid service identity name/);
  });

  it("grants full authority to the service identities and the owner, and nothing to anyone else", () => {
    const scopes = openClawIdentityScopes("uid-owner");
    expect(scopes[OPENCLAW_EDGE_SERVICE_IDENTITY]).toEqual([...OPENCLAW_FULL_OPERATOR_SCOPES]);
    expect(scopes[OPENCLAW_PROVISIONER_SERVICE_IDENTITY]).toEqual([...OPENCLAW_FULL_OPERATOR_SCOPES]);
    expect(scopes["uid-owner"]).toEqual([...OPENCLAW_FULL_OPERATOR_SCOPES]);
    expect(Object.keys(scopes)).toHaveLength(3);
    expect(Object.keys(openClawIdentityScopes(undefined))).toHaveLength(2);
    expect(Object.keys(openClawIdentityScopes("  "))).toHaveLength(2);
  });

  it("auto-approves devices up to the authenticated role ceiling", () => {
    expect(OPENCLAW_TRUSTED_PROXY_AUTH.trustedProxy.deviceAutoApprove).toEqual({
      enabled: true,
      scopes: [...OPENCLAW_FULL_OPERATOR_SCOPES],
    });
    expect(OPENCLAW_FULL_OPERATOR_SCOPES).toContain("operator.admin");
  });

  it("defaults new profiles to Member permissions", () => {
    expect(OPENCLAW_OPERATOR_ROLES.default).toBe("member");
    expect(OPENCLAW_OPERATOR_ROLES.definitions.member.scopes).toEqual(["operator.read", "operator.write", "operator.questions"]);
    expect(OPENCLAW_OPERATOR_ROLES.definitions.member.sessions.others).toBe("none");
    expect(Object.keys(OPENCLAW_OPERATOR_ROLES.definitions).sort()).toEqual(
      ["admin", "member", "service"],
    );
  });

  it("requests the exact native Member or Admin scopes", () => {
    expect(openClawRoleScopes("member")).toEqual(["operator.read", "operator.write", "operator.questions"]);
    expect(openClawRoleScopes("admin")).toEqual([...OPENCLAW_FULL_OPERATOR_SCOPES]);
    expect(OPENCLAW_OPERATOR_ROLES.definitions.admin.sessions.others).toBe("write");
    expect(OPENCLAW_OPERATOR_ROLES.definitions.admin.agents).toBe("*");
  });

  it("derives one stable device per gateway, person and role from the pod secret", () => {
    const subject = openClawDeviceSubject("bender", "uid-alice");
    const first = deriveDeviceIdentity({ secret: "pod-secret", subject });
    const again = deriveDeviceIdentity({ secret: "pod-secret", subject });
    const otherPerson = deriveDeviceIdentity({ secret: "pod-secret", subject: openClawDeviceSubject("bender", "uid-bob") });
    const otherSecret = deriveDeviceIdentity({ secret: "rotated", subject });
    expect(again).toEqual(first);
    expect(otherPerson.deviceId).not.toBe(first.deviceId);
    expect(otherSecret.deviceId).not.toBe(first.deviceId);
    expect(first.deviceId).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.deviceId).not.toBe(generateIdentity().deviceId);
    expect(() => deriveDeviceIdentity({ secret: "", subject })).toThrow(/non-empty secret/);
  });

  it("identifies inbound identity headers case-insensitively so proxies strip them", () => {
    expect(isOpenClawProxyIdentityHeader("X-Octogee-User")).toBe(true);
    expect(isOpenClawProxyIdentityHeader("x-octogee-proxy")).toBe(true);
    expect(isOpenClawProxyIdentityHeader("x-forwarded-for")).toBe(false);
  });
});
