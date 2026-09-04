import { describe, expect, it } from "vitest";

import {
  OPENCLAW_EDGE_SERVICE_IDENTITY,
  OPENCLAW_OPERATOR_ROLES,
  OPENCLAW_PROXY_ATTESTATION_HEADER,
  OPENCLAW_PROXY_USER_HEADER,
  OPENCLAW_TRUSTED_PROXY_AUTH,
  isOpenClawProxyIdentityHeader,
  isPerUserControlIdentity,
  openClawProxyIdentityHeaders,
  openClawRoleForBrokerProfile,
  resolveControlIdentityFromEnv,
  serviceProxyIdentity,
} from "./openclaw-proxy-identity";

describe("OpenClaw proxy identity contract", () => {
  it("activates only on the explicit per-user environment value", () => {
    expect(resolveControlIdentityFromEnv({})).toBe("shared-operator");
    expect(resolveControlIdentityFromEnv({ OPENCLAW_CONTROL_IDENTITY: "per-user" })).toBe("per-user");
    expect(resolveControlIdentityFromEnv({ OPENCLAW_CONTROL_IDENTITY: " per-user " })).toBe("per-user");
    expect(isPerUserControlIdentity({ OPENCLAW_CONTROL_IDENTITY: "trusted-proxy" })).toBe(false);
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
    expect(() => serviceProxyIdentity("Gateway Edge")).toThrow(/invalid service identity name/);
  });

  it("maps every broker profile onto a configured operator role", () => {
    expect(openClawRoleForBrokerProfile("native-owner")).toBe("owner");
    expect(openClawRoleForBrokerProfile("native-co-owner")).toBe("co-owner");
    expect(openClawRoleForBrokerProfile("delegated-config")).toBe("trusted-helper");
    expect(openClawRoleForBrokerProfile("delegated-read")).toBe("viewer");
    for (const role of ["owner", "co-owner", "trusted-helper", "viewer", "service", "guest"]) {
      expect(OPENCLAW_OPERATOR_ROLES.definitions).toHaveProperty(role);
    }
    expect(OPENCLAW_OPERATOR_ROLES.default).toBe("guest");
  });

  it("identifies inbound identity headers case-insensitively so proxies strip them", () => {
    expect(isOpenClawProxyIdentityHeader("X-Octogee-User")).toBe(true);
    expect(isOpenClawProxyIdentityHeader("x-octogee-proxy")).toBe(true);
    expect(isOpenClawProxyIdentityHeader("x-forwarded-for")).toBe(false);
  });
});
