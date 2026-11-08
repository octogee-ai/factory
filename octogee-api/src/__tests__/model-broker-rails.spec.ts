import { describe, expect, it } from "vitest";

import type { OwnerModelBrokerGrant } from "../lib/model-broker-limits.js";
import {
  createModelBrokerRailRegistry,
  operatorRail,
  operatorRailRegistry,
  requireSpendWindowAllowance,
  UnknownModelBrokerRailError,
  type ModelBrokerRail,
} from "../lib/model-broker-rails.js";
import { InMemoryModelBrokerUsageStore } from "../lib/model-broker-usage.js";
import { WebResearchError } from "../lib/web-research-error.js";

function grant(overrides: Partial<OwnerModelBrokerGrant> = {}): OwnerModelBrokerGrant {
  return {
    limits: { spendWindowUsd: null, spendWeekUsd: null, requestsPerMinute: null },
    policy: { freeTier: false, houseFallback: true },
    rail: "operator",
    signupOfferBudget: null,
    ...overrides,
  };
}

const allowed = {
  allowed: true as const,
  degrade: false,
  degradeReason: null,
  windowCostUsd: null,
  weekCostUsd: null,
  creditBalanceUsd: null,
  offerFunded: false,
  offerChargeUsd: null,
};

describe("model broker rail registry", () => {
  it("looks rails up by id and fails loud on an unregistered rail", () => {
    const registry = operatorRailRegistry();
    expect(registry.defaultRailId).toBe("operator");
    expect(registry.rail("operator")).toBe(operatorRail);
    expect(() => registry.rail("prepaid_credits")).toThrow(UnknownModelBrokerRailError);
    expect(() => registry.rail("prepaid_credits")).toThrow(/not registered: "prepaid_credits"/);
  });

  it("refuses duplicate ids and a default that is not registered", () => {
    const other: ModelBrokerRail = { ...operatorRail, id: "other" };
    expect(() => createModelBrokerRailRegistry({ rails: [operatorRail, operatorRail], defaultRailId: "operator" }))
      .toThrow(/unique/);
    expect(() => createModelBrokerRailRegistry({ rails: [other], defaultRailId: "operator" }))
      .toThrow(/default model broker rail is not registered/);
  });

  it("resolves no owner profile unless a registry supplies one", () => {
    expect(operatorRailRegistry().resolveOwnerProfile({ subscription: { tier: "personal" } }, "uid", 0)).toBeNull();
  });
});

describe("operator rail", () => {
  it("adds no gate of its own and never bills credits", async () => {
    const ctx = { grant: grant(), gatewayId: "g1", ownerUid: "u1", now: () => 0 };
    expect(operatorRail.requiresGate(grant(), "u1")).toBe(false);
    expect(await operatorRail.gate(ctx, { spendWindowUsd: 10, spendWeekUsd: 50 })).toBeNull();
    expect(operatorRail.usingCredits(grant(), { ...allowed, creditBalanceUsd: 5 }, "u1")).toBe(false);
    expect(operatorRail.logFields(grant())).toEqual({});
  });

  it("denies with 402 when the budget is exhausted and no house model is configured", async () => {
    const ctx = { grant: grant({ policy: { freeTier: false, houseFallback: false } }), gatewayId: "g1", ownerUid: "u1", now: () => 0 };
    const outcome = await operatorRail.budgetExhausted(ctx);
    expect(outcome).toMatchObject({ kind: "denied", decision: { allowed: false, status: 402 } });
    expect(outcome.kind === "denied" && outcome.decision.allowed === false ? outcome.decision.error : "")
      .toMatch(/no house model is configured/);
  });

  it("meters web research against the spend window and refuses when exhausted", async () => {
    const usageStore = new InMemoryModelBrokerUsageStore({ prepaidCreditMarkupMultiplier: 1 });
    const within = await operatorRail.allowance({
      usageStore,
      grant: grant({ limits: { spendWindowUsd: 10, spendWeekUsd: null, requestsPerMinute: null } }),
      gatewayId: "g1",
      ownerUid: "u1",
      now: 1_000,
    });
    expect(within).toEqual({ debitsCreditBalance: false, countsTowardSpendWindow: true });

    await usageStore.recordUsage({
      eventId: "e1",
      requestId: "r1",
      upstreamId: null,
      provider: "anthropic",
      gatewayId: "g1",
      ownerUid: "u1",
      agentId: null,
      brokerTokenHash: "h",
      brokerTokenSecretName: "s",
      providerKeySource: "platform",
      providerKeySecretName: null,
      degraded: false,
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      cacheWriteTtl: null,
      method: "POST",
      path: "/v1/messages",
      upstreamStatus: 200,
      now: 1_000,
      countsTowardSpendWindow: true,
      chargeUsd: 25,
      usageKind: "web_search",
    });
    await expect(operatorRail.allowance({
      usageStore,
      grant: grant({ limits: { spendWindowUsd: 10, spendWeekUsd: null, requestsPerMinute: null } }),
      gatewayId: "g1",
      ownerUid: "u1",
      now: 2_000,
    })).rejects.toMatchObject({ code: "allowance_exhausted", status: 429 });
  });

  it("lets a rail decide what happens when the window is exhausted without a house model", async () => {
    const usageStore = new InMemoryModelBrokerUsageStore({ prepaidCreditMarkupMultiplier: 1 });
    await usageStore.recordUsage({
      eventId: "e1",
      requestId: "r1",
      upstreamId: null,
      provider: "anthropic",
      gatewayId: "g1",
      ownerUid: "u1",
      agentId: null,
      brokerTokenHash: "h",
      brokerTokenSecretName: "s",
      providerKeySource: "platform",
      providerKeySecretName: null,
      degraded: false,
      model: "claude-haiku-4-5",
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      cacheWriteTtl: null,
      method: "POST",
      path: "/v1/messages",
      upstreamStatus: 200,
      now: 1_000,
      countsTowardSpendWindow: true,
      chargeUsd: 25,
      usageKind: "web_search",
    });
    const input = {
      usageStore,
      grant: grant({
        limits: { spendWindowUsd: 10, spendWeekUsd: null, requestsPerMinute: null },
        policy: { freeTier: false, houseFallback: false },
      }),
      gatewayId: "g1",
      ownerUid: "u1",
      now: 2_000,
    };
    const fallback = { debitsCreditBalance: true, countsTowardSpendWindow: false };
    expect(await requireSpendWindowAllowance(input, async () => fallback)).toEqual(fallback);
    await expect(requireSpendWindowAllowance(input, async () => {
      throw new WebResearchError("credits_exhausted", 402, "none");
    })).rejects.toMatchObject({ code: "credits_exhausted" });
  });
});

describe("operator rail spend throttle", () => {
  const under = {
    modelAccess: "catalog" as const,
    windowCostUsd: 1,
    windowBudgetUsd: 4,
    weekCostUsd: 2,
    weekBudgetUsd: 20,
    onOwnerCredential: false,
    houseFallback: false,
    creditBalanceUsd: 9,
  };

  it("stays clear while budgets have room", () => {
    expect(operatorRail.throttle(under)).toEqual({
      degraded: false,
      blocked: false,
      reason: null,
      creditBalanceVisible: false,
    });
  });

  it("blocks a spent budget when no house model is configured, whatever the credit balance", () => {
    expect(operatorRail.throttle({ ...under, windowCostUsd: 4 })).toEqual({
      degraded: false,
      blocked: true,
      reason: "window_exhausted",
      creditBalanceVisible: false,
    });
  });

  it("degrades a spent budget onto the house model when one is configured", () => {
    expect(operatorRail.throttle({ ...under, weekCostUsd: 20, houseFallback: true })).toEqual({
      degraded: true,
      blocked: false,
      reason: "week_exhausted",
      creditBalanceVisible: false,
    });
  });

  it("ignores spend on the owner's own credential", () => {
    expect(operatorRail.throttle({ ...under, weekCostUsd: 20, onOwnerCredential: true }).blocked).toBe(false);
  });
});
