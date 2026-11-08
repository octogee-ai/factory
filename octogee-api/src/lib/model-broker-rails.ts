import type { OwnedSignupOfferBudget } from "@octogee/shared/types/signup-offer";

import {
  exhaustedSpendBudget,
  type ModelAccess,
  type SpendThrottleState,
} from "@octogee/shared/types/model-broker-usage";

import type { DegradeOutcome, GateDecisionAllowed, RailGateContext, SpendBudgets } from "./model-broker-gate.js";
import type { OwnerModelBrokerGrant } from "./model-broker-limits.js";
import type { ModelBrokerUsageStore } from "./model-broker-usage.js";
import { readPlatformSpendState } from "./platform-usage-allowance.js";
import { WebResearchError } from "./web-research-error.js";

export interface OwnerRailProfile {
  rail: string;
  spendWindowUsd: number;
  spendWeekUsd: number;
  windowBudgets: boolean;
  freeTier: boolean;
  houseFallback: boolean;
  signupOfferBudget: OwnedSignupOfferBudget | null;
}

export interface RailAllowanceInput {
  usageStore: ModelBrokerUsageStore;
  grant: OwnerModelBrokerGrant;
  gatewayId: string;
  ownerUid: string;
  now: number;
  onSignupOfferBudgetInterruption?: (input: {
    uid: string;
    reason: "waiting_for_unlock" | "hard_cap_exhausted";
  }) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export interface RailAllowanceResult {
  debitsCreditBalance: boolean;
  countsTowardSpendWindow: boolean;
  signupOfferBudget?: OwnedSignupOfferBudget;
}

export interface RailSpendObservation {
  modelAccess: ModelAccess;
  windowCostUsd: number;
  windowBudgetUsd: number;
  weekCostUsd: number;
  weekBudgetUsd: number;
  onOwnerCredential: boolean;
  houseFallback: boolean;
  creditBalanceUsd: number;
}

export interface RailSpendThrottle extends SpendThrottleState {
  creditBalanceVisible: boolean;
}

export interface ModelBrokerRail {
  readonly id: string;
  requiresGate(grant: OwnerModelBrokerGrant, ownerUid: string | null): boolean;
  gate(ctx: RailGateContext, budgets: SpendBudgets): Promise<DegradeOutcome | null>;
  budgetExhausted(ctx: RailGateContext): Promise<DegradeOutcome>;
  usingCredits(grant: OwnerModelBrokerGrant, gate: GateDecisionAllowed, ownerUid: string | null): boolean;
  allowance(input: RailAllowanceInput): Promise<RailAllowanceResult>;
  throttle(observation: RailSpendObservation): RailSpendThrottle;
  logFields(grant: OwnerModelBrokerGrant): Record<string, unknown>;
}

export interface ModelBrokerRailRegistry {
  readonly defaultRailId: string;
  rail(id: string): ModelBrokerRail;
  resolveOwnerProfile(ownerData: Record<string, unknown>, ownerUid: string, now: number): OwnerRailProfile | null;
}

export class UnknownModelBrokerRailError extends Error {
  constructor(public readonly railId: string) {
    super(`model broker rail is not registered: ${JSON.stringify(railId)}`);
    this.name = "UnknownModelBrokerRailError";
  }
}

export function createModelBrokerRailRegistry(input: {
  rails: readonly ModelBrokerRail[];
  defaultRailId: string;
  resolveOwnerProfile?: ModelBrokerRailRegistry["resolveOwnerProfile"];
}): ModelBrokerRailRegistry {
  const byId = new Map(input.rails.map((rail) => [rail.id, rail] as const));
  if (byId.size !== input.rails.length) throw new Error("model broker rail ids must be unique");
  if (!byId.has(input.defaultRailId)) {
    throw new Error(`default model broker rail is not registered: ${JSON.stringify(input.defaultRailId)}`);
  }
  return {
    defaultRailId: input.defaultRailId,
    rail(id) {
      const rail = byId.get(id);
      if (!rail) throw new UnknownModelBrokerRailError(id);
      return rail;
    },
    resolveOwnerProfile: input.resolveOwnerProfile ?? (() => null),
  };
}

export async function requireSpendWindowAllowance(
  input: RailAllowanceInput,
  onExhaustedWithoutHouse: () => Promise<RailAllowanceResult>,
): Promise<RailAllowanceResult> {
  const state = await readPlatformSpendState({
    usageStore: input.usageStore,
    gatewayId: input.gatewayId,
    ownerUid: input.ownerUid,
    now: input.now,
    spendWindowUsd: input.grant.limits.spendWindowUsd,
    spendWeekUsd: input.grant.limits.spendWeekUsd,
  });
  if (!state.available) {
    throw new WebResearchError("billing_unavailable", 503, "Platform allowance gate unavailable");
  }
  if (state.exhausted) {
    if (input.grant.policy.houseFallback === false) return onExhaustedWithoutHouse();
    throw new WebResearchError("allowance_exhausted", 429, "Platform allowance exhausted");
  }
  return { debitsCreditBalance: false, countsTowardSpendWindow: true };
}

export const OPERATOR_RAIL_ID = "operator";

export const operatorRail: ModelBrokerRail = {
  id: OPERATOR_RAIL_ID,
  requiresGate: () => false,
  gate: async () => null,
  budgetExhausted: async () => ({
    kind: "denied",
    decision: {
      allowed: false,
      status: 402,
      error: "model budget exhausted for this window and no house model is configured",
    },
  }),
  usingCredits: () => false,
  allowance: (input) =>
    requireSpendWindowAllowance(input, async () => {
      throw new WebResearchError("allowance_exhausted", 429, "Platform allowance exhausted");
    }),
  throttle: (observation) => {
    const exhausted = observation.onOwnerCredential ? null : exhaustedSpendBudget(observation);
    if (!exhausted) return { degraded: false, blocked: false, reason: null, creditBalanceVisible: false };
    return {
      degraded: observation.houseFallback,
      blocked: !observation.houseFallback,
      reason: `${exhausted}_exhausted`,
      creditBalanceVisible: false,
    };
  },
  logFields: () => ({}),
};

export function operatorRailRegistry(): ModelBrokerRailRegistry {
  return createModelBrokerRailRegistry({ rails: [operatorRail], defaultRailId: OPERATOR_RAIL_ID });
}
