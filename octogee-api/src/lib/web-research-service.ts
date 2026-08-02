import * as crypto from "node:crypto";

import type { LiveOwnerGrantResolver, OwnerModelBrokerGrant } from "./model-broker-limits.js";
import type { ModelBrokerUsageStore } from "./model-broker-usage.js";
import type {
  BraveSearchInput,
  BraveSearchOutput,
  TavilyExtractInput,
  TavilyExtractOutput,
  TavilySearchInput,
  TavilySearchOutput,
} from "./web-provider-clients.js";
import { WebProviderError } from "./web-provider-clients.js";
import { readPlatformSpendState } from "./platform-usage-allowance.js";

export type WebResearchErrorCode =
  | "allowance_exhausted"
  | "credits_exhausted"
  | "billing_unavailable"
  | "rate_limited"
  | "provider_unconfigured"
  | "provider_rate_limited"
  | "provider_error";

export class WebResearchError extends Error {
  constructor(
    public readonly code: WebResearchErrorCode,
    public readonly status: 402 | 429 | 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = "WebResearchError";
  }
}

interface AttributedCall {
  gatewayId: string;
  ownerUid: string;
  agentId: string;
  requestId: string;
}

export type WebResearchSearchInput = AttributedCall &
  ({ provider: "brave" } & BraveSearchInput | { provider: "tavily" } & TavilySearchInput);

export type WebResearchExtractInput = AttributedCall & TavilyExtractInput;

interface WebResearchServiceOptions {
  usageStore: ModelBrokerUsageStore;
  resolveGrant: LiveOwnerGrantResolver;
  braveSearch?: (input: BraveSearchInput) => Promise<BraveSearchOutput>;
  tavilySearch?: (input: TavilySearchInput) => Promise<TavilySearchOutput>;
  tavilyExtract?: (input: TavilyExtractInput) => Promise<TavilyExtractOutput>;
  now?: () => number;
  braveCostPerRequestUsd: number;
  tavilyCostPerCreditUsd: number;
  markupMultiplier: number;
  onError?: (error: unknown) => void;
  onSignupOfferBudgetInterruption?: (input: {
    uid: string;
    reason: "waiting_for_unlock" | "hard_cap_exhausted";
  }) => void | Promise<void>;
}

const EMPTY_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

interface AllowanceInput {
  usageStore: ModelBrokerUsageStore;
  grant: OwnerModelBrokerGrant;
  gatewayId: string;
  ownerUid: string;
  now: number;
  onSignupOfferBudgetInterruption?: WebResearchServiceOptions["onSignupOfferBudgetInterruption"];
  onError?: (error: unknown) => void;
}

interface AllowanceResult {
  debitsCreditBalance: boolean;
  countsTowardSpendWindow: boolean;
  signupOfferBudget?: NonNullable<OwnerModelBrokerGrant["signupOfferBudget"]>;
}

async function requireCreditBalance(input: AllowanceInput): Promise<AllowanceResult> {
  if (!input.usageStore.readCreditBalance) {
    throw new WebResearchError("billing_unavailable", 503, "Platform Credit gate unavailable");
  }
  const balance = await input.usageStore.readCreditBalance(input.ownerUid);
  if (balance <= 0) {
    throw new WebResearchError("credits_exhausted", 402, "Platform Credits exhausted");
  }
  return { debitsCreditBalance: true, countsTowardSpendWindow: false };
}

async function reportSignupOfferInterruption(
  input: AllowanceInput,
  reason: "waiting_for_unlock" | "hard_cap_exhausted",
): Promise<void> {
  try {
    await input.onSignupOfferBudgetInterruption?.({ uid: input.ownerUid, reason });
  } catch (error) {
    input.onError?.(error);
  }
}

async function requireSignupOfferAllowance(input: AllowanceInput): Promise<AllowanceResult> {
  const budget = input.grant.signupOfferBudget;
  if (!budget || !input.usageStore.readSignupOfferBudget) {
    throw new WebResearchError("billing_unavailable", 503, "Signup Offer budget gate unavailable");
  }
  const ledger = await input.usageStore.readSignupOfferBudget(budget);
  if (!ledger) {
    throw new WebResearchError("billing_unavailable", 503, "Signup Offer budget ledger unavailable");
  }
  if (ledger.chargeUsd < budget.unlockedCapUsd) {
    return {
      debitsCreditBalance: false,
      countsTowardSpendWindow: false,
      signupOfferBudget: budget,
    };
  }
  if (input.usageStore.readCreditBalance) {
    const balance = await input.usageStore.readCreditBalance(input.ownerUid);
    if (balance > 0) {
      return { debitsCreditBalance: true, countsTowardSpendWindow: false };
    }
  }
  const reason = budget.nextUnlockAtMs !== null && ledger.chargeUsd < budget.hardCapUsd
    ? "waiting_for_unlock"
    : "hard_cap_exhausted";
  await reportSignupOfferInterruption(input, reason);
  const message = reason === "waiting_for_unlock"
    ? "Signup Offer capacity unlocks again soon"
    : "Signup Offer model allowance is complete";
  throw new WebResearchError("allowance_exhausted", 402, message);
}

async function requireSubscriptionAllowance(input: AllowanceInput): Promise<AllowanceResult> {
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
    if (input.grant.policy.houseFallback === false) {
      return requireCreditBalance(input);
    }
    throw new WebResearchError("allowance_exhausted", 429, "Platform allowance exhausted");
  }
  return { debitsCreditBalance: false, countsTowardSpendWindow: true };
}

async function requireAllowance(input: AllowanceInput): Promise<AllowanceResult> {
  if (input.grant.rail === "prepaid_credits") return requireCreditBalance(input);
  if (input.grant.rail === "signup_offer") return requireSignupOfferAllowance(input);
  return requireSubscriptionAllowance(input);
}

async function requireRequestRate(input: {
  usageStore: ModelBrokerUsageStore;
  grant: OwnerModelBrokerGrant;
  gatewayId: string;
  ownerUid: string;
  now: number;
}): Promise<void> {
  const requestsPerMinute = input.grant.limits.requestsPerMinute;
  if (requestsPerMinute === null) return;
  if (!input.usageStore.reserveRateWindow) {
    throw new WebResearchError("billing_unavailable", 503, "Platform rate gate unavailable");
  }
  const rate = await input.usageStore.reserveRateWindow({
    gatewayId: input.gatewayId,
    ownerUid: input.ownerUid,
    now: input.now,
  });
  if (rate.requestCount > requestsPerMinute) {
    throw new WebResearchError("rate_limited", 429, "Platform request rate limit exceeded");
  }
}

function eventId(input: AttributedCall, tool: "brave_search" | "tavily_search" | "tavily_extract"): string {
  return `web_${crypto
    .createHash("sha256")
    .update(`${input.gatewayId}\0${input.agentId}\0${tool}\0${input.requestId}`, "utf8")
    .digest("hex")}`;
}

function mapProviderError(error: unknown): never {
  if (error instanceof WebResearchError) throw error;
  if (error instanceof WebProviderError) {
    throw new WebResearchError(
      error.code === "provider_rate_limited" ? "provider_rate_limited" : "provider_error",
      error.code === "provider_rate_limited" ? 429 : 502,
      error.message,
    );
  }
  throw new WebResearchError("provider_error", 502, "Web research provider failed");
}

export function createWebResearchService(options: WebResearchServiceOptions) {
  const now = options.now ?? Date.now;

  async function admission(input: AttributedCall) {
    const at = now();
    try {
      const grant = await options.resolveGrant({
        gatewayId: input.gatewayId,
        ownerUid: input.ownerUid,
        now: at,
      });
      const billing = await requireAllowance({
        usageStore: options.usageStore,
        grant,
        gatewayId: input.gatewayId,
        ownerUid: input.ownerUid,
        now: at,
        onSignupOfferBudgetInterruption: options.onSignupOfferBudgetInterruption,
        onError: options.onError,
      });
      await requireRequestRate({
        usageStore: options.usageStore,
        grant,
        gatewayId: input.gatewayId,
        ownerUid: input.ownerUid,
        now: at,
      });
      return { at, billing };
    } catch (error) {
      if (error instanceof WebResearchError) throw error;
      options.onError?.(error);
      throw new WebResearchError("billing_unavailable", 503, "Platform billing gate unavailable");
    }
  }

  async function meter(input: {
    call: AttributedCall;
    kind: "web_search" | "web_extract";
    tool: "brave_search" | "tavily_search" | "tavily_extract";
    provider: "brave" | "tavily";
    model: string;
    costUsd: number;
    at: number;
    billing: {
      debitsCreditBalance: boolean;
      countsTowardSpendWindow: boolean;
      signupOfferBudget?: NonNullable<OwnerModelBrokerGrant["signupOfferBudget"]>;
    };
    metadata: Record<string, unknown>;
  }): Promise<void> {
    try {
      await options.usageStore.recordUsage({
        eventId: eventId(input.call, input.tool),
        requestId: input.call.requestId,
        provider: input.provider,
        gatewayId: input.call.gatewayId,
        ownerUid: input.call.ownerUid,
        agentId: input.call.agentId,
        usageKind: input.kind,
        toolName: input.tool,
        model: input.model,
        usage: EMPTY_USAGE,
        method: "POST",
        path: `/internal/fleet/agent/${input.kind === "web_search" ? "web-search" : "web-extract"}`,
        upstreamStatus: 200,
        now: input.at,
        reportedCostUsd: input.costUsd,
        chargeUsd: input.costUsd * options.markupMultiplier,
        debitsCreditBalance: input.billing.debitsCreditBalance,
        countsTowardSpendWindow: input.billing.countsTowardSpendWindow,
        signupOfferBudget: input.billing.signupOfferBudget,
        providerMetadata: input.metadata,
      });
    } catch (error) {
      options.onError?.(error);
      throw new WebResearchError("billing_unavailable", 503, "Platform usage recording failed");
    }
  }

  return {
    async search(input: WebResearchSearchInput): Promise<BraveSearchOutput | TavilySearchOutput> {
      if (input.provider === "brave" && !options.braveSearch) {
        throw new WebResearchError("provider_unconfigured", 503, "Brave search is not configured");
      }
      if (input.provider === "tavily" && !options.tavilySearch) {
        throw new WebResearchError("provider_unconfigured", 503, "Tavily search is not configured");
      }
      const admitted = await admission(input);
      try {
        if (input.provider === "brave") {
          const output = await options.braveSearch!(input);
          await meter({
            call: input,
            kind: "web_search",
            tool: "brave_search",
            provider: "brave",
            model: "brave/web-search",
            costUsd: options.braveCostPerRequestUsd,
            at: admitted.at,
            billing: admitted.billing,
            metadata: { requestId: output.requestId },
          });
          return output;
        }
        const output = await options.tavilySearch!(input);
        const attributedCredits = input.searchDepth === "advanced" ? 2 : 1;
        await meter({
          call: input,
          kind: "web_search",
          tool: "tavily_search",
          provider: "tavily",
          model: `tavily/search-${input.searchDepth ?? "basic"}`,
          costUsd: attributedCredits * options.tavilyCostPerCreditUsd,
          at: admitted.at,
          billing: admitted.billing,
          metadata: {
            requestId: output.requestId,
            providerCredits: output.credits,
            attributedCredits,
          },
        });
        return output;
      } catch (error) {
        mapProviderError(error);
      }
    },

    async extract(input: WebResearchExtractInput): Promise<TavilyExtractOutput> {
      if (!options.tavilyExtract) {
        throw new WebResearchError("provider_unconfigured", 503, "Tavily extraction is not configured");
      }
      const admitted = await admission(input);
      try {
        const output = await options.tavilyExtract(input);
        const attributedCredits =
          output.successfulUrlCount * (input.extractDepth === "advanced" ? 2 : 1) / 5;
        await meter({
          call: input,
          kind: "web_extract",
          tool: "tavily_extract",
          provider: "tavily",
          model: `tavily/extract-${input.extractDepth ?? "basic"}`,
          costUsd: attributedCredits * options.tavilyCostPerCreditUsd,
          at: admitted.at,
          billing: admitted.billing,
          metadata: {
            requestId: output.requestId,
            providerCredits: output.credits,
            successfulUrlCount: output.successfulUrlCount,
            attributedCredits,
          },
        });
        return output;
      } catch (error) {
        mapProviderError(error);
      }
    },
  };
}
