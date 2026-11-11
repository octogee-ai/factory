import { afterEach, describe, expect, it } from "vitest";
import {
  installUserEntitlements,
  staticUserEntitlements,
  userEntitlements,
} from "@octogee/shared/types/user-entitlements";
import { buildUserSummary, type BrokerUserUsage } from "./admin-shape.js";
import { userAccountFromData } from "./user-account.js";
import { userRecordFromData } from "./platform-state/firestore/users.js";

const NOW = Date.UTC(2026, 6, 2, 13, 30);
const LIVE_SIGNUP_OFFER = {
  schemaVersion: 3,
  offerId: "builder-signup",
  offerVersion: 1,
  personalTier: "personal",
  builderTier: "hobby",
  configHash: "config-a",
  claimedAt: new Date(NOW),
  endsAt: new Date(NOW + 7 * 24 * 60 * 60 * 1000),
};

function summarize(uid: string, data: Record<string, unknown>, broker?: BrokerUserUsage) {
  return buildUserSummary(userRecordFromData(uid, data, 0, null), userAccountFromData(uid, data), broker);
}

describe("buildUserSummary", () => {
  it("carries the account lifecycle so a list can mark users scheduled for deletion", () => {
    expect(summarize("u1", { email: "a@b.co" }).accountLifecycleStatus).toBe("active");
    expect(summarize("u1", {
      email: "a@b.co",
      accountLifecycle: { status: "deletion_scheduled", eraseAfter: 1_800_000_000_000 },
    }).accountLifecycleStatus).toBe("deletion_scheduled");
  });

  it("normalizes malformed nested user fields instead of leaking them", () => {
    const summary = summarize("uid-1", {
      email: "user@example.com",
      subscription: {
        tier: { name: "pro" },
        status: 42,
      },
      usage: {
        costUsd: "not-a-number",
        throttleLevel: "blocked",
        totalTokensUsed: "a lot",
      },
      provisioning: {
        status: "queued",
      },
      mattermost: {
        username: 456,
      },
    });

    expect(summary).toMatchObject({
      uid: "uid-1",
      displayName: "user",
      email: "user@example.com",
      tier: "personal_free",
      subscriptionStatus: "trial",
      costUsd: 0,
      totalTokensUsed: 0,
      brokerTotalTokens: 0,
      agentCount: 0,
      mattermostConnected: false,
      mattermostUsername: null,
      provisioningStatus: "queued",
    });
  });

  it("derives `degraded` from the broker window spend, not the legacy throttle field", () => {
    // free tier is always on the house model
    expect(summarize("u", { subscription: { tier: "free" } }).degraded).toBe(true);

    // a user on their own credential (BYOT) is never throttled
    expect(
      summarize("u", { subscription: { tier: "free" }, byotActive: true }).degraded,
    ).toBe(false);

    // paid tier: under both budgets vs over the burst window vs over the week
    const paid = { selectedTier: "pro", subscription: { tier: "pro" } };
    expect(summarize("u", paid, { windowCostUsd: 0, now: NOW }).degraded).toBe(false);
    expect(summarize("u", paid, { windowCostUsd: 9999, now: NOW }).degraded).toBe(false);
    expect(summarize("u", paid, { weekCostUsd: 9999, now: NOW }).degraded).toBe(false);
  });

  it("does not label an exhausted active trial as running on HOUSE", () => {
    const trial = { trialGrant: LIVE_SIGNUP_OFFER };
    expect(
      summarize("u", trial, { windowCostUsd: 9999, now: NOW }).degraded,
    ).toBe(false);
  });

  it("shows 0% (not a zero-budget 100%) for owner-credential users — mirrors the user surfaces", () => {
    // free/house-only tier + BYOT: weeklyBudgetUsd is 0, so an unguarded percentage
    // would read 100% despite the broker never metering or throttling this traffic.
    const summary = summarize(
      "u",
      { subscription: { tier: "free" }, byotActive: true },
      { windowCostUsd: 5, weekCostUsd: 40, now: NOW },
    );
    expect(summary.percentUsed).toBe(0);
    expect(summary.weekPercentUsed).toBe(0);
    expect(summary.degraded).toBe(false);
  });

  it("uses broker spend for the window percentage and never renders legacy token windows", () => {
    const summary = summarize(
      "u",
      {
        trialGrant: LIVE_SIGNUP_OFFER,
        usage: { windowTokensUsed: 676_435, totalTokensUsed: 1_145_873 },
      },
      { windowCostUsd: 0.008, weekCostUsd: 2.07, now: NOW },
    );

    expect(summary.windowCostUsd).toBe(0.008);
    expect(summary.weekCostUsd).toBe(2.07);
    expect(summary.tier).toBe("personal_free");
    expect(summary.effectiveTier).toBe("personal");
    expect(summary.trialDaysRemaining).toBe(7);
    // TokenMath v2: weekly defining limit, burst window = weekly × 3 / 42
    expect(summary.weekBudgetUsd).toBeCloseTo((15 * 7) / 30.44, 4);
    expect(summary.windowBudgetUsd).toBeCloseTo(((15 * 7) / 30.44) * (3 / 42), 4);
    expect(summary.weekPercentUsed).toBe(60);
    expect(summary.percentUsed).toBe(3);
    expect(summary.degraded).toBe(false);
    // legacy token-window fields are gone from the admin contract
    expect(summary).not.toHaveProperty("windowTokensUsed");
    expect(summary).not.toHaveProperty("windowSize");
    expect(summary).not.toHaveProperty("available");
    expect(summary).not.toHaveProperty("weeklyBudget");
    expect(summary).not.toHaveProperty("tokensLimit");
    // token counts survive as telemetry only
    expect(summary.totalTokensUsed).toBe(1_145_873);
  });

  it("sources cost + metered tokens from the broker rollup, and margin from broker cost", () => {
    const summary = summarize(
      "u",
      {
        selectedTier: "pro",
        subscription: { tier: "pro", status: "active" },
        usage: { costUsd: 0 }, // legacy $0 must not leak into the admin figure
      },
      { windowCostUsd: 0.5, totalCostUsd: 12.34, totalTokens: 2_000_000, now: NOW },
    );

    expect(summary.costUsd).toBe(12.34);
    expect(summary.brokerTotalTokens).toBe(2_000_000);
    expect(summary.revenueUsd).toBeGreaterThan(0);
    expect(summary.marginUsd).toBeCloseTo(summary.revenueUsd - 12.34, 5);
  });

  it("reports the epoch-aligned 4h window refill time", () => {
    const summary = summarize(
      "u",
      { trialGrant: LIVE_SIGNUP_OFFER },
      { windowCostUsd: 0, now: NOW },
    );
    // 13:30Z sits in the 12:00–16:00Z window → refill at 16:00Z
    expect(summary.nextRefillAt).toBe(new Date(Date.UTC(2026, 6, 2, 16)).toISOString());
  });

  it("caps the window percentage at 100 and treats a zero budget as fully used", () => {
    const paid = { selectedTier: "pro", subscription: { tier: "pro" } };
    expect(
      summarize("u", paid, { windowCostUsd: 9_999, now: NOW }).percentUsed,
    ).toBe(100);
    // non-subscription plan (builder tier) → zero budget → fully used
    expect(
      summarize("u", { selectedTier: "builder" }, { now: NOW }).percentUsed,
    ).toBe(100);
  });

  it("meters a post-trial free user against the $1 weekly house allowance", () => {
    const free = { subscription: { tier: "trial" } };
    expect(summarize("u", free, { now: NOW }).percentUsed).toBe(0);
    expect(
      summarize("u", free, { windowCostUsd: 9_999, now: NOW }).percentUsed,
    ).toBe(100);
  });
});

describe("buildUserSummary commercial fields", () => {
  const productResolver = userEntitlements();
  const paying = { email: "a@b.co", subscription: { tier: "personal", status: "active" } };

  afterEach(() => {
    installUserEntitlements(productResolver);
  });

  it("merges the product projection into the summary", () => {
    const summary = summarize("u1", paying, { now: NOW, totalCostUsd: 5 });

    expect(summary).toMatchObject({ uid: "u1", tier: "personal", subscriptionStatus: "active", revenueUsd: 20 });
    expect(summary.marginUsd).toBeCloseTo(15, 5);
  });

  it("carries no commercial field on a bare platform", () => {
    installUserEntitlements(staticUserEntitlements);

    const summary = summarize("u1", paying);

    expect(summary).toMatchObject({ uid: "u1", email: "a@b.co" });
    for (const field of ["tier", "effectiveTier", "trialDaysRemaining", "subscriptionStatus", "revenueUsd", "marginUsd"]) {
      expect(summary).not.toHaveProperty(field);
    }
  });
});
