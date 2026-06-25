import { describe, expect, it } from "vitest";
import { buildCustomerSummary } from "./admin-shape.js";

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
        windowTokensUsed: "a lot",
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
      tier: "trial",
      subscriptionStatus: "trial",
      costUsd: 0,
      windowTokensUsed: 0,
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

    // paid tier: under window budget (3rd arg = broker window spend) vs over it
    const paid = { selectedTier: "pro", subscription: { tier: "pro" } };
    expect(buildCustomerSummary("u", paid, 0).degraded).toBe(false);
    expect(buildCustomerSummary("u", paid, 9999).degraded).toBe(true);
  });
});
