import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installDefaultUserEntitlements,
  installUserEntitlements,
  staticUserEntitlements,
  userEntitlements,
  type UserEntitlementResolver,
} from "./user-entitlements";

const slot = Symbol.for("octogee.userEntitlements");
const host = globalThis as unknown as Record<symbol, UserEntitlementResolver | undefined>;
const installed = host[slot];

afterEach(() => {
  host[slot] = installed;
  vi.resetModules();
});

describe("userEntitlements", () => {
  it("refuses to resolve before a resolver is installed", () => {
    delete host[slot];
    expect(() => userEntitlements()).toThrow("User entitlements resolver is not installed");
  });

  it("installs the static resolver for a bare platform process", () => {
    delete host[slot];
    installDefaultUserEntitlements();
    expect(userEntitlements()).toBe(staticUserEntitlements);
  });

  it("preserves an explicitly installed product resolver during platform initialization", () => {
    const product = { ...staticUserEntitlements, sizingKey: () => "product-size" };
    installUserEntitlements(product);
    installDefaultUserEntitlements();
    expect(userEntitlements()).toBe(product);
  });

  it("returns the installed resolver", () => {
    installUserEntitlements(staticUserEntitlements);
    expect(userEntitlements()).toBe(staticUserEntitlements);
  });

  it("shares the installed resolver across separate copies of the module", async () => {
    installUserEntitlements(staticUserEntitlements);
    vi.resetModules();
    const copy = await import("./user-entitlements");
    expect(copy.userEntitlements()).toBe(staticUserEntitlements);
  });
});

describe("staticUserEntitlements", () => {
  it("grants every user the catalog without metering them", () => {
    const policy = staticUserEntitlements.policy({});
    expect(policy.modelAccess).toBe("catalog");
    expect(policy.houseFallback).toBe(false);
    expect(policy.spendWeekUsd).toBeGreaterThan(1_000_000);
    expect(policy.spendWindowUsd).toBeGreaterThan(1_000_000);
    expect(Object.keys(policy).sort()).toEqual([
      "houseFallback",
      "modelAccess",
      "spendWeekUsd",
      "spendWindowUsd",
      "toolAccess",
    ]);
  });

  it("keeps projects active and unlimited with one configured sizing key", () => {
    expect(staticUserEntitlements.projectMode({})).toBe("active");
    expect(staticUserEntitlements.maxProjects({})).toBe("unlimited");
    expect(staticUserEntitlements.sizingKey({})).toBe("default");
  });

  it("sends a gateway on a previous image no field of its own on any wire", () => {
    const account = { tier: "operator", selectedTier: "personal", subscription: { tier: "personal" }, trialExpired: true };
    for (const wire of ["user-snapshot", "restore-snapshot", "model-pick-push", "model-credential-push"] as const) {
      expect(staticUserEntitlements.previousImageFields(wire, account)).toEqual({});
    }
  });

  it("carries no plan inputs and no product projection", () => {
    expect(staticUserEntitlements.pickInputs({ subscription: { tier: "personal" } })).toEqual({});
    expect(staticUserEntitlements.productProjection).toBeUndefined();
  });

  it("seeds and converges every user onto one context template without removing files", () => {
    expect(staticUserEntitlements.contextFilePolicy({})).toEqual({ templateKey: "default", removedFiles: [] });
    expect(staticUserEntitlements.seedContextTemplateKey({ tier: "personal_free" })).toBe("default");
  });

  it("enforces a spent budget generically, degrading only when a house model exists", () => {
    const policy = { ...staticUserEntitlements.policy({}), spendWindowUsd: 4, spendWeekUsd: 20 };
    const observation = { windowCostUsd: 4, weekCostUsd: 1, onOwnerCredential: false };
    expect(staticUserEntitlements.spendThrottle(policy, observation)).toEqual({
      degraded: false,
      blocked: true,
      reason: "window_exhausted",
    });
    expect(staticUserEntitlements.spendThrottle({ ...policy, houseFallback: true }, observation)).toEqual({
      degraded: true,
      blocked: false,
      reason: "window_exhausted",
    });
    expect(staticUserEntitlements.spendThrottle(policy, { ...observation, onOwnerCredential: true }).blocked).toBe(false);
  });
});

describe("isolated gateway admission", () => {
  it("refuses self-service requests when no product admission is installed", () => {
    expect(staticUserEntitlements.isolatedGatewayAdmission({})).toEqual({
      admitted: false,
      code: "isolated-gateway-operator-grant-required",
      reason: "No admission policy is installed; an operator grants isolated gateways through the Admin API",
    });
  });
});
