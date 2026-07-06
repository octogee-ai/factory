import { describe, expect, it } from "vitest";
import { buildCustomerSummary } from "./admin-shape.js";

const NOW = Date.UTC(2026, 6, 2, 13, 30);

describe("buildCustomerSummary", () => {
  it("normalizes malformed nested customer fields instead of leaking them", () => {
    const summary = buildCustomerSummary("uid-1", {
      email: "builder@example.com",
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
        openclaw: {
          agentIds: "agent-1",
          status: 99,
        },
        status: "queued",
      },
      mattermost: {
        userId: 123,
        username: 456,
      },
    });

    expect(summary).toMatchObject({
      uid: "uid-1",
      displayName: "builder",
      email: "builder@example.com",
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
    expect(buildCustomerSummary("u", { subscription: { tier: "free" } }).degraded).toBe(true);

    // a builder on their own credential (BYOT) is never throttled
    expect(
      buildCustomerSummary("u", { subscription: { tier: "free" }, byotActive: true }).degraded,
    ).toBe(false);

    // paid tier: under both budgets vs over the burst window vs over the week
    const paid = { selectedTier: "pro", subscription: { tier: "pro" } };
    expect(buildCustomerSummary("u", paid, { windowCostUsd: 0, now: NOW }).degraded).toBe(false);
    expect(buildCustomerSummary("u", paid, { windowCostUsd: 9999, now: NOW }).degraded).toBe(true);
    expect(buildCustomerSummary("u", paid, { weekCostUsd: 9999, now: NOW }).degraded).toBe(true);
  });

  it("shows 0% (not a zero-budget 100%) for owner-credential customers — mirrors the customer surfaces", () => {
    // free/house-only tier + BYOT: weeklyBudgetUsd is 0, so an unguarded percentage
    // would read 100% despite the broker never metering or throttling this traffic.
    const summary = buildCustomerSummary(
      "u",
      { subscription: { tier: "free" }, byotActive: true },
      { windowCostUsd: 5, weekCostUsd: 40, now: NOW },
    );
    expect(summary.percentUsed).toBe(0);
    expect(summary.weekPercentUsed).toBe(0);
    expect(summary.degraded).toBe(false);
  });

  it("uses broker spend for the window percentage and never renders legacy token windows", () => {
    const summary = buildCustomerSummary(
      "u",
      {
        subscription: { tier: "trial", trialStartedAt: new Date(NOW) },
        usage: { windowTokensUsed: 676_435, totalTokensUsed: 1_145_873 },
      },
      { windowCostUsd: 0.008, weekCostUsd: 2.07, now: NOW },
    );

    expect(summary.windowCostUsd).toBe(0.008);
    expect(summary.weekCostUsd).toBe(2.07);
    // legacy "trial" maps to personal_free + the 7-day Personal Pro boost
    expect(summary.tier).toBe("personal_free");
    expect(summary.effectiveTier).toBe("personal_pro");
    expect(summary.trialDaysRemaining).toBe(7);
    // TokenMath v2: weekly defining limit, burst window = weekly × 3 / 42
    expect(summary.weekBudgetUsd).toBeCloseTo((90 * 7) / 30.44, 4);
    expect(summary.windowBudgetUsd).toBeCloseTo(((90 * 7) / 30.44) * (3 / 42), 4);
    expect(summary.weekPercentUsed).toBe(10); // $2.07 of the ~$20.70 Personal Pro weekly ledger
    expect(summary.percentUsed).toBe(1); // $0.008 of the ~$1.48 Personal Pro burst window
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
    const summary = buildCustomerSummary(
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
    const summary = buildCustomerSummary(
      "u",
      { subscription: { tier: "trial", trialStartedAt: new Date(NOW) } },
      { windowCostUsd: 0, now: NOW },
    );
    // 13:30Z sits in the 12:00–16:00Z window → refill at 16:00Z
    expect(summary.nextRefillAt).toBe(new Date(Date.UTC(2026, 6, 2, 16)).toISOString());
  });

  it("caps the window percentage at 100 and treats a zero budget as fully used", () => {
    const paid = { selectedTier: "pro", subscription: { tier: "pro" } };
    expect(
      buildCustomerSummary("u", paid, { windowCostUsd: 9_999, now: NOW }).percentUsed,
    ).toBe(100);
    // post-trial (no trialStartedAt) → zero budget → fully used
    expect(
      buildCustomerSummary("u", { subscription: { tier: "trial" } }, { now: NOW }).percentUsed,
    ).toBe(100);
  });
});
