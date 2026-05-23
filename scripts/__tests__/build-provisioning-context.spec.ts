import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "path";
import { buildProvisioningContext } from "../lib/provisionSteps.js";
import { CUSTOMERS_DIR } from "../lib/config.js";

describe("buildProvisioningContext", () => {
  beforeEach(() => {
    vi.useFakeTimers();

vi.setSystemTime(new Date("2026-03-14T08:30:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("populates every field from a minimal user doc", () => {
    const ctx = buildProvisioningContext("uid-1", { username: "acme" });

    expect(ctx).toEqual({
      uid: "uid-1",
      slug: "acme",
      tier: "trial",
      ownerName: "acme",
      customerDir: path.join(CUSTOMERS_DIR, "acme"),
      today: "2026-03-14",
      username: "acme",
      templateVars: {
        uid: "uid-1",
        ownerName: "acme",
        username: "acme",
        tier: "trial",
        createdAt: "2026-03-14",
        slug: "acme",
      },
      userData: { username: "acme" },
    });
  });

  it("uses top-level userData.tier when present", () => {
    const ctx = buildProvisioningContext("uid-1", {
      username: "acme",
      tier: "pro",
      subscription: { tier: "should-be-ignored" },
    });

    expect(ctx.tier).toBe("pro");
    expect(ctx.templateVars.tier).toBe("pro");
  });

  it("falls through to subscription.tier when top-level tier is missing", () => {
    const ctx = buildProvisioningContext("uid-1", {
      username: "acme",
      subscription: { tier: "pro" },
    });

    expect(ctx.tier).toBe("pro");
  });

  it("defaults tier to 'trial' when neither top-level nor subscription carry one", () => {
    const ctx = buildProvisioningContext("uid-1", { username: "acme" });

    expect(ctx.tier).toBe("trial");
  });

  it("slug, ownerName, and username all derive from userData.username (DATA-MODEL-REVIEW v3 §2)", () => {
    const ctx = buildProvisioningContext("uid-1", { username: "bendecho" });

    expect(ctx.slug).toBe("bendecho");
    expect(ctx.ownerName).toBe("bendecho");
    expect(ctx.username).toBe("bendecho");
  });

  it("customerDir composes from CUSTOMERS_DIR + slug — not from any user-controlled field", () => {
    const ctx = buildProvisioningContext("uid-1", {
      username: "acme",
      customerDir: "/attacker/controlled",
    });

    expect(ctx.customerDir).toBe(path.join(CUSTOMERS_DIR, "acme"));
  });

  it("templateVars contains the six substitution keys consumed by readTierTemplateFile", () => {
    const ctx = buildProvisioningContext("uid-1", { username: "acme", tier: "pro" });

    expect(Object.keys(ctx.templateVars).sort()).toEqual([
      "createdAt",
      "ownerName",
      "slug",
      "tier",
      "uid",
      "username",
    ]);
  });

  it("today is the current UTC date as YYYY-MM-DD (ISO date slice, time-of-day irrelevant)", () => {
    vi.setSystemTime(new Date("2026-12-31T23:59:59Z"));
    const ctx = buildProvisioningContext("uid-1", { username: "acme" });

    expect(ctx.today).toBe("2026-12-31");
    expect(ctx.templateVars.createdAt).toBe("2026-12-31");
  });

  it("passes userData through unchanged on the returned ctx (steps read auxiliary fields off it)", () => {
    const userData = {
      username: "acme",
      email: "a@b.co",
      onboarding: { vibe: "calm" },
      displayName: "First Last",
      photoURL: "https://example.com/a.png",
    };
    const ctx = buildProvisioningContext("uid-1", userData);

    expect(ctx.userData).toBe(userData);
  });

  it("throws when userData.username is missing — onboarding must run first", () => {
    expect(() => buildProvisioningContext("uid-1", {})).toThrow(
      /Cannot provision uid=uid-1: missing users\/\{uid\}\.username/,
    );
  });

  it("throws when userData.username is an empty string", () => {
    expect(() => buildProvisioningContext("uid-1", { username: "" })).toThrow(
      /missing users\/\{uid\}\.username/,
    );
  });

  it("throws when userData.username is not a string (number, object, null)", () => {
    expect(() => buildProvisioningContext("uid-1", { username: 42 })).toThrow(
      /missing users\/\{uid\}\.username/,
    );
    expect(() => buildProvisioningContext("uid-1", { username: null })).toThrow(
      /missing users\/\{uid\}\.username/,
    );
    expect(() =>
      buildProvisioningContext("uid-1", { username: { v: "acme" } }),
    ).toThrow(/missing users\/\{uid\}\.username/);
  });

  it("error message carries the uid so log readers can trace which user failed", () => {
    expect(() => buildProvisioningContext("user-abc-123", {})).toThrow(
      /uid=user-abc-123/,
    );
  });
});
