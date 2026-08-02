import * as crypto from "node:crypto";
import type {
  DocumentData,
  DocumentReference,
  Firestore,
  Transaction,
} from "firebase-admin/firestore";

import { WINDOW_LENGTH_HOURS } from "@octogee/shared/types/billing";
import {
  MODEL_BROKER_CREDITS_COLLECTION,
  MODEL_BROKER_USAGE_EVENTS_COLLECTION,
  MODEL_BROKER_USAGE_ROLLUPS_COLLECTION,
  MODEL_BROKER_USAGE_WINDOWS_COLLECTION,
  MODEL_BROKER_WEEK_WINDOWS_COLLECTION,
  MODEL_BROKER_WEEK_WINDOW_MS,
  MODEL_BROKER_RATE_WINDOWS_COLLECTION,
  MODEL_BROKER_RATE_WINDOW_MS,
  modelBrokerWindowDocId as windowDocId,
  rateWindowStartMs,
  usageWindowStartMs,
  weekWindowStartMs,
  windowOwnerKey,
} from "@octogee/shared/types/model-broker-usage";
import {
  MODEL_BROKER_SIGNUP_OFFER_BUDGETS_COLLECTION,
  SIGNUP_OFFER_LEDGER_RETENTION_MS,
  parseModelBrokerSignupOfferBudget,
  type ModelBrokerSignupOfferBudget,
  type SignupOfferBudgetIdentity,
} from "@octogee/shared/types/signup-offer";

export type ModelBrokerUsageProvider =
  | "anthropic"
  | "openrouter"
  | "openai"
  | "brave"
  | "tavily";
export type AnthropicCacheWriteTtl = "5m" | "1h";

export interface AnthropicTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export type ModelBrokerCostSource = "estimated" | "openrouter_reported" | "provider_reported";

export interface ModelBrokerUsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  pricingModel: string;
  cacheWriteTtl: AnthropicCacheWriteTtl;
  source: ModelBrokerCostSource;
}

export type ModelBrokerUsageProviderKeySource = "platform" | "owner_model_credential";

export interface ModelBrokerUsageRecordInput {
  eventId?: string;
  requestId: string;
  upstreamId?: string | null;
  provider: ModelBrokerUsageProvider;
  gatewayId: string;
  ownerUid: string | null;
  brokerTokenHash?: string | null;
  brokerTokenSecretName?: string | null;
  providerKeySource?: ModelBrokerUsageProviderKeySource | null;
  providerKeySecretName?: string | null;
  degraded?: boolean;
  model: string;
  usage: AnthropicTokenUsage;
  cacheWriteTtl?: AnthropicCacheWriteTtl;
  method: string;
  path: string;
  upstreamStatus: number;
  now?: number;
  countsTowardSpendWindow?: boolean;
  // Prepaid rail (Builders): the metering transaction also debits the owner's
  // modelBrokerCredits balance by the priced cost. The final call may push the
  // balance slightly negative; the pre-flight gate blocks the next one.
  debitsCreditBalance?: boolean;
  signupOfferBudget?: SignupOfferBudgetIdentity & { budgetKey: string };
  // The upstream's own USD accounting (OpenRouter `usage.cost`). Authoritative
  // over the static pricing table when present — the table is fallback only.
  reportedCostUsd?: number | null;
  chargeUsd?: number;
  usageKind?: "model" | "embedding" | "web_search" | "web_extract";
  agentId?: string | null;
  toolName?: string | null;
  providerMetadata?: Record<string, unknown>;
}

export interface ModelBrokerUsageStore {
  recordUsage(input: ModelBrokerUsageRecordInput): Promise<void>;
  readWindowUsage?(input: ModelBrokerUsageWindowReadInput): Promise<ModelBrokerUsageWindowSnapshot>;
  readWeekUsage?(input: ModelBrokerUsageWindowReadInput): Promise<ModelBrokerWeekSnapshot>;
  reserveRateWindow?(input: ModelBrokerRateWindowReserveInput): Promise<ModelBrokerRateWindowSnapshot>;
  readCreditBalance?(ownerUid: string): Promise<number>;
  readSignupOfferBudget?(
    input: SignupOfferBudgetIdentity & { budgetKey: string },
  ): Promise<ModelBrokerSignupOfferBudget | null>;
}

export interface ModelBrokerWeekSnapshot {
  ownerKey: string;
  weekStartMs: number;
  requestCount: number;
  totalTokens: number;
  costUsd: number;
  chargeUsd: number;
}

export interface ModelBrokerUsageWindowReadInput {
  gatewayId: string;
  ownerUid?: string | null;
  now?: number;
}

export interface ModelBrokerUsageWindowSnapshot {
  ownerKey: string;
  windowStartMs: number;
  requestCount: number;
  totalTokens: number;
  costUsd: number;
  chargeUsd: number;
}

export interface ModelBrokerRateWindowReserveInput {
  gatewayId: string;
  ownerUid?: string | null;
  scope?: "embedding";
  now?: number;
}

export interface ModelBrokerRateWindowSnapshot {
  ownerKey: string;
  windowStartMs: number;
  requestCount: number;
}

// Storage contract (collection names + window-key math) is single-sourced in
// shared/ so the read side (gateway-edge usage panel) can't drift from it.
export {
  MODEL_BROKER_USAGE_EVENTS_COLLECTION,
  MODEL_BROKER_USAGE_ROLLUPS_COLLECTION,
  MODEL_BROKER_USAGE_WINDOWS_COLLECTION,
  MODEL_BROKER_RATE_WINDOWS_COLLECTION,
  rateWindowStartMs,
  usageWindowStartMs,
  windowOwnerKey,
};

const TOKENS_PER_MILLION = 1_000_000;
const USAGE_RETENTION_DAYS = 180;

interface AnthropicPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
  pricingModel: string;
}

// Snapshot from Claude API pricing, verified 2026-06-18:
// https://platform.claude.com/docs/en/about-claude/pricing
const ANTHROPIC_PRICING: Record<string, AnthropicPricing> = {
  fable: pricing(10, 50, "fable"),
  mythos: pricing(10, 50, "mythos"),
  "opus-latest": pricing(5, 25, "opus-latest"),
  "opus-legacy": pricing(15, 75, "opus-legacy"),
  sonnet: pricing(3, 15, "sonnet"),
  "haiku-4.5": pricing(1, 5, "haiku-4.5"),
  "haiku-3.5": pricing(0.8, 4, "haiku-3.5"),
};
const UNKNOWN_MODEL_FALLBACK_PRICING = pricing(10, 50, "unknown-fable-fallback");
// Snapshot from OpenRouter's model API, verified 2026-07-30. Luna includes the 50% promotion.
const OPENROUTER_PRICING: Record<string, AnthropicPricing> = {
  "z-ai/glm-5.2": pricing(0.94, 3, "openrouter:z-ai/glm-5.2"),
  "deepseek/deepseek-v4-pro": pricing(0.435, 0.87, "openrouter:deepseek/deepseek-v4-pro"),
  "openai/gpt-5.6-luna": pricing(0.1, 0.6, "openrouter:openai/gpt-5.6-luna"),
};
const UNKNOWN_OPENROUTER_FALLBACK_PRICING = pricing(1, 5, "openrouter:unknown-fallback");
// Snapshot from the OpenAI API pricing page, verified 2026-07-08:
// https://developers.openai.com/api/docs/pricing (cached input = 10% of input).
const OPENAI_PRICING: Record<string, AnthropicPricing> = {
  "gpt-5.4-mini": pricing(0.75, 4.5, "openai:gpt-5.4-mini"),
  "text-embedding-3-small": pricing(
    0.02,
    0,
    "openai:text-embedding-3-small",
  ),
};
const UNKNOWN_OPENAI_FALLBACK_PRICING = pricing(2.5, 15, "openai:unknown-fallback");

function pricing(inputPerMTok: number, outputPerMTok: number, pricingModel: string): AnthropicPricing {
  return {
    inputPerMTok,
    outputPerMTok,
    cacheWrite5mPerMTok: inputPerMTok * 1.25,
    cacheWrite1hPerMTok: inputPerMTok * 2,
    cacheReadPerMTok: inputPerMTok * 0.1,
    pricingModel,
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function normalizeAnthropicUsage(value: unknown): AnthropicTokenUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const usage = {
    inputTokens: numberOrZero(data.input_tokens),
    outputTokens: numberOrZero(data.output_tokens),
    cacheCreationInputTokens: numberOrZero(data.cache_creation_input_tokens),
    cacheReadInputTokens: numberOrZero(data.cache_read_input_tokens),
  };
  return totalTokens(usage) > 0 ? usage : null;
}

export function totalTokens(usage: AnthropicTokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens
  );
}

export function mergeAnthropicUsage(
  current: AnthropicTokenUsage | null,
  next: AnthropicTokenUsage | null,
): AnthropicTokenUsage | null {
  if (!next) return current;
  if (!current) return next;
  return {
    inputTokens: Math.max(current.inputTokens, next.inputTokens),
    outputTokens: Math.max(current.outputTokens, next.outputTokens),
    cacheCreationInputTokens: Math.max(
      current.cacheCreationInputTokens,
      next.cacheCreationInputTokens,
    ),
    cacheReadInputTokens: Math.max(current.cacheReadInputTokens, next.cacheReadInputTokens),
  };
}

function modelPricing(model: string): AnthropicPricing {
  const normalized = model.toLowerCase();
  if (normalized.includes("fable")) return ANTHROPIC_PRICING.fable;
  if (normalized.includes("mythos")) return ANTHROPIC_PRICING.mythos;
  if (normalized.includes("sonnet")) return ANTHROPIC_PRICING.sonnet;
  if (
    normalized.includes("haiku-3-5") ||
    normalized.includes("haiku-3.5") ||
    normalized.includes("3-5-haiku") ||
    normalized.includes("3.5-haiku")
  ) {
    return ANTHROPIC_PRICING["haiku-3.5"];
  }
  if (normalized.includes("haiku")) return ANTHROPIC_PRICING["haiku-4.5"];
  if (normalized.includes("opus-4-1") || normalized.includes("opus-4-0")) {
    return ANTHROPIC_PRICING["opus-legacy"];
  }
  if (normalized.includes("opus")) return ANTHROPIC_PRICING["opus-latest"];
  return UNKNOWN_MODEL_FALLBACK_PRICING;
}

export function isUnknownAnthropicPricingModel(pricingModel: string): boolean {
  return pricingModel === UNKNOWN_MODEL_FALLBACK_PRICING.pricingModel;
}

function usd(tokens: number, perMTok: number): number {
  return (tokens / TOKENS_PER_MILLION) * perMTok;
}

export function estimateAnthropicCost(
  model: string,
  usage: AnthropicTokenUsage,
  cacheWriteTtl: AnthropicCacheWriteTtl = "5m",
): ModelBrokerUsageCost {
  const prices = modelPricing(model);
  const input = usd(usage.inputTokens, prices.inputPerMTok);
  const output = usd(usage.outputTokens, prices.outputPerMTok);
  const cacheRead = usd(usage.cacheReadInputTokens, prices.cacheReadPerMTok);
  const cacheWrite = usd(
    usage.cacheCreationInputTokens,
    cacheWriteTtl === "1h" ? prices.cacheWrite1hPerMTok : prices.cacheWrite5mPerMTok,
  );
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    pricingModel: prices.pricingModel,
    cacheWriteTtl,
    source: "estimated",
  };
}

function openRouterModelPricing(model: string): AnthropicPricing {
  const normalized = model.toLowerCase();
  if (normalized === "z-ai/glm-5.2" || normalized.startsWith("z-ai/glm-5.2-")) {
    return OPENROUTER_PRICING["z-ai/glm-5.2"];
  }
  return OPENROUTER_PRICING[normalized] ?? UNKNOWN_OPENROUTER_FALLBACK_PRICING;
}

function openAiModelPricing(model: string): AnthropicPricing {
  const normalized = model.toLowerCase();
  return (
    OPENAI_PRICING[normalized] ??
    Object.entries(OPENAI_PRICING).find(([id]) => normalized.startsWith(`${id}-`))?.[1] ??
    UNKNOWN_OPENAI_FALLBACK_PRICING
  );
}

export function isUnknownOpenAiPricingModel(pricingModel: string): boolean {
  return pricingModel === UNKNOWN_OPENAI_FALLBACK_PRICING.pricingModel;
}

export function estimateModelBrokerCost(
  provider: ModelBrokerUsageProvider,
  model: string,
  usage: AnthropicTokenUsage,
  cacheWriteTtl: AnthropicCacheWriteTtl = "5m",
): ModelBrokerUsageCost {
  if (provider === "anthropic") return estimateAnthropicCost(model, usage, cacheWriteTtl);
  if (provider === "brave" || provider === "tavily") {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      pricingModel: model,
      cacheWriteTtl,
      source: "estimated",
    };
  }
  const prices = provider === "openai" ? openAiModelPricing(model) : openRouterModelPricing(model);
  const input = usd(usage.inputTokens + usage.cacheCreationInputTokens, prices.inputPerMTok);
  const output = usd(usage.outputTokens, prices.outputPerMTok);
  const cacheRead = usd(usage.cacheReadInputTokens, prices.cacheReadPerMTok);
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    total: input + output + cacheRead,
    pricingModel: prices.pricingModel,
    cacheWriteTtl,
    source: "estimated",
  };
}

// The upstream's own accounting beats any table: when OpenRouter reports
// `usage.cost`, that USD figure is what the platform key was actually charged.
// The estimated breakdown is rescaled to the reported total so attribution
// still sums, and the source is stamped for TEST verification.
export function resolveRecordedCost(
  input: Pick<ModelBrokerUsageRecordInput, "provider" | "model" | "usage" | "reportedCostUsd">,
  cacheWriteTtl: AnthropicCacheWriteTtl,
): ModelBrokerUsageCost {
  const estimated = estimateModelBrokerCost(input.provider, input.model, input.usage, cacheWriteTtl);
  const reported = input.reportedCostUsd;
  if (typeof reported !== "number" || !Number.isFinite(reported) || reported < 0) {
    return estimated;
  }
  const scale = estimated.total > 0 ? reported / estimated.total : 0;
  return {
    input: estimated.total > 0 ? estimated.input * scale : reported,
    output: estimated.output * scale,
    cacheRead: estimated.cacheRead * scale,
    cacheWrite: estimated.cacheWrite * scale,
    total: reported,
    pricingModel: estimated.pricingModel,
    cacheWriteTtl,
    source:
      input.provider === "brave" || input.provider === "tavily"
        ? "provider_reported"
        : "openrouter_reported",
  };
}

function resolvedChargeUsd(
  input: ModelBrokerUsageRecordInput,
  cost: ModelBrokerUsageCost,
): number {
  const charge = input.chargeUsd;
  return typeof charge === "number" && Number.isFinite(charge) && charge >= 0
    ? charge
    : cost.total;
}

export function isUnknownOpenRouterPricingModel(pricingModel: string): boolean {
  return pricingModel === UNKNOWN_OPENROUTER_FALLBACK_PRICING.pricingModel;
}

export function modelRollupKey(model: string): string {
  return model.replace(/[/.]/g, "_").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) || "unknown";
}

function rateWindowOwnerKey(input: ModelBrokerRateWindowReserveInput): string {
  const ownerKey = windowOwnerKey(input);
  return input.scope ? `${ownerKey}:${input.scope}` : ownerKey;
}


function expiresAt(now: number): Date {
  return new Date(now + USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberField(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function chargeField(data: Record<string, unknown>): number {
  return typeof data.chargeUsd === "number" && Number.isFinite(data.chargeUsd)
    ? data.chargeUsd
    : numberField(data, "costUsd");
}

function addUsageFields(
  existing: Record<string, unknown>,
  usage: AnthropicTokenUsage,
  cost: ModelBrokerUsageCost,
  chargeUsd: number,
): Record<string, number> {
  const existingCost = asRecord(existing.costBreakdown);
  return {
    requestCount: numberField(existing, "requestCount") + 1,
    totalTokens: numberField(existing, "totalTokens") + totalTokens(usage),
    inputTokens: numberField(existing, "inputTokens") + usage.inputTokens,
    outputTokens: numberField(existing, "outputTokens") + usage.outputTokens,
    cacheCreationInputTokens:
      numberField(existing, "cacheCreationInputTokens") + usage.cacheCreationInputTokens,
    cacheReadInputTokens:
      numberField(existing, "cacheReadInputTokens") + usage.cacheReadInputTokens,
    costUsd: numberField(existing, "costUsd") + cost.total,
    chargeUsd: chargeField(existing) + chargeUsd,
    costInput: numberField(existingCost, "input") + cost.input,
    costOutput: numberField(existingCost, "output") + cost.output,
    costCacheRead: numberField(existingCost, "cacheRead") + cost.cacheRead,
    costCacheWrite: numberField(existingCost, "cacheWrite") + cost.cacheWrite,
  };
}

function usageDocumentTotals(
  existing: Record<string, unknown>,
  usage: AnthropicTokenUsage,
  cost: ModelBrokerUsageCost,
  chargeUsd: number,
): Record<string, unknown> {
  const totals = addUsageFields(existing, usage, cost, chargeUsd);
  return {
    requestCount: totals.requestCount,
    totalTokens: totals.totalTokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheCreationInputTokens: totals.cacheCreationInputTokens,
    cacheReadInputTokens: totals.cacheReadInputTokens,
    costUsd: totals.costUsd,
    chargeUsd: totals.chargeUsd,
    costBreakdown: {
      input: totals.costInput,
      output: totals.costOutput,
      cacheRead: totals.costCacheRead,
      cacheWrite: totals.costCacheWrite,
    },
  };
}

function modelTotals(input: {
  existing: Record<string, unknown>;
  modelKey: string;
  model: string;
  provider: ModelBrokerUsageProvider;
  usage: AnthropicTokenUsage;
  cost: ModelBrokerUsageCost;
  chargeUsd: number;
}): Record<string, unknown> {
  const models = asRecord(input.existing.models);
  const current = asRecord(models[input.modelKey]);
  return {
    ...models,
    [input.modelKey]: {
      provider: input.provider,
      model: input.model,
      billingModel: input.cost.pricingModel,
      totalTokens: numberField(current, "totalTokens") + totalTokens(input.usage),
      costUsd: numberField(current, "costUsd") + input.cost.total,
      chargeUsd: chargeField(current) + input.chargeUsd,
      requestCount: numberField(current, "requestCount") + 1,
    },
  };
}

function traceFields(input: ModelBrokerUsageRecordInput): Record<string, unknown> {
  return {
    brokerTokenHash: input.brokerTokenHash ?? null,
    brokerTokenSecretName: input.brokerTokenSecretName ?? null,
    providerKeySource: input.providerKeySource ?? null,
    providerKeySecretName: input.providerKeySecretName ?? null,
    degraded: input.degraded === true,
    countsTowardSpendWindow: input.countsTowardSpendWindow !== false,
  };
}

function latestTraceFields(input: ModelBrokerUsageRecordInput): Record<string, unknown> {
  return {
    lastBrokerTokenHash: input.brokerTokenHash ?? null,
    lastBrokerTokenSecretName: input.brokerTokenSecretName ?? null,
    lastProviderKeySource: input.providerKeySource ?? null,
    lastProviderKeySecretName: input.providerKeySecretName ?? null,
    lastDegraded: input.degraded === true,
    lastCountsTowardSpendWindow: input.countsTowardSpendWindow !== false,
  };
}

function eventDocument(
  input: ModelBrokerUsageRecordInput & {
    eventId: string;
    now: number;
    cacheWriteTtl: AnthropicCacheWriteTtl;
    cost: ModelBrokerUsageCost;
    chargeUsd: number;
    windowStartMs: number;
  },
): Record<string, unknown> {
  return {
    eventId: input.eventId,
    requestId: input.requestId,
    upstreamId: input.upstreamId ?? null,
    provider: input.provider,
    gatewayId: input.gatewayId,
    ownerUid: input.ownerUid,
    usageKind: input.usageKind ?? "model",
    agentId: input.agentId ?? null,
    toolName: input.toolName ?? null,
    providerMetadata: input.providerMetadata ?? {},
    signupOfferBudgetKey: input.signupOfferBudget?.budgetKey ?? null,
    ...traceFields(input),
    model: input.model,
    modelKey: modelRollupKey(input.model),
    method: input.method,
    path: input.path,
    upstreamStatus: input.upstreamStatus,
    createdAt: input.now,
    expiresAt: expiresAt(input.now),
    windowStartMs: input.windowStartMs,
    usage: input.usage,
    totalTokens: totalTokens(input.usage),
    costUsd: input.cost.total,
    chargeUsd: input.chargeUsd,
    costBreakdown: {
      input: input.cost.input,
      output: input.cost.output,
      cacheRead: input.cost.cacheRead,
      cacheWrite: input.cost.cacheWrite,
    },
    pricing: {
      model: input.cost.pricingModel,
      cacheWriteTtl: input.cacheWriteTtl,
      source: input.cost.source,
    },
  };
}

function requireSignupOfferLedger(
  budgets: Map<string, ModelBrokerSignupOfferBudget>,
  budget: ModelBrokerUsageRecordInput["signupOfferBudget"],
): ModelBrokerSignupOfferBudget | undefined {
  if (!budget) return undefined;
  const ledger = parseModelBrokerSignupOfferBudget(budgets.get(budget.budgetKey), budget);
  if (!ledger) {
    throw new Error("signup offer budget ledger missing or does not match the active receipt");
  }
  return ledger;
}

export class InMemoryModelBrokerUsageStore implements ModelBrokerUsageStore {
  readonly events: Array<Record<string, unknown>> = [];
  readonly rollups = new Map<string, Record<string, unknown> & { totalTokens: number; costUsd: number; chargeUsd: number; requestCount: number }>();
  readonly windows = new Map<string, ModelBrokerUsageWindowSnapshot & Record<string, unknown>>();
  readonly weekWindows = new Map<string, ModelBrokerWeekSnapshot & Record<string, unknown>>();
  readonly rateWindows = new Map<string, ModelBrokerRateWindowSnapshot>();
  readonly creditBalances = new Map<string, number>();
  readonly signupOfferBudgets = new Map<string, ModelBrokerSignupOfferBudget>();
  private readonly eventIds = new Set<string>();

  async recordUsage(input: ModelBrokerUsageRecordInput): Promise<void> {
    const now = input.now ?? Date.now();
    const cacheWriteTtl = input.cacheWriteTtl ?? "5m";
    const cost = resolveRecordedCost(input, cacheWriteTtl);
    const chargeUsd = resolvedChargeUsd(input, cost);
    const eventId = input.eventId ?? crypto.randomUUID();
    if (this.eventIds.has(eventId)) return;
    const signupOfferLedger = requireSignupOfferLedger(this.signupOfferBudgets, input.signupOfferBudget);
    this.eventIds.add(eventId);
    const windowStartMs = usageWindowStartMs(now);
    const ownerKey = windowOwnerKey(input);
    this.events.push(
      eventDocument({
        ...input,
        eventId,
        now,
        cacheWriteTtl,
        cost,
        chargeUsd,
        windowStartMs,
      }),
    );
    const existing = this.rollups.get(ownerKey) ?? {
      totalTokens: 0,
      costUsd: 0,
      chargeUsd: 0,
      requestCount: 0,
    };
    this.rollups.set(ownerKey, {
      totalTokens: existing.totalTokens + totalTokens(input.usage),
      costUsd: existing.costUsd + cost.total,
      chargeUsd: existing.chargeUsd + chargeUsd,
      requestCount: existing.requestCount + 1,
      models: modelTotals({
        existing,
        modelKey: modelRollupKey(input.model),
        model: input.model,
        provider: input.provider,
        usage: input.usage,
        cost,
        chargeUsd,
      }),
      ...latestTraceFields(input),
    });
    if (input.countsTowardSpendWindow !== false) {
      const windowKey = windowDocId(ownerKey, windowStartMs);
      const existingWindow = this.windows.get(windowKey) ?? {
        ownerKey,
        windowStartMs,
        totalTokens: 0,
        costUsd: 0,
        chargeUsd: 0,
        requestCount: 0,
      };
      this.windows.set(windowKey, {
        ownerKey,
        windowStartMs,
        totalTokens: existingWindow.totalTokens + totalTokens(input.usage),
        costUsd: existingWindow.costUsd + cost.total,
        chargeUsd: existingWindow.chargeUsd + chargeUsd,
        requestCount: existingWindow.requestCount + 1,
        ...latestTraceFields(input),
      });
      const weekStartMs = weekWindowStartMs(now);
      const weekKey = windowDocId(ownerKey, weekStartMs);
      const existingWeek = this.weekWindows.get(weekKey) ?? {
        ownerKey,
        weekStartMs,
        totalTokens: 0,
        costUsd: 0,
        chargeUsd: 0,
        requestCount: 0,
      };
      this.weekWindows.set(weekKey, {
        ownerKey,
        weekStartMs,
        totalTokens: existingWeek.totalTokens + totalTokens(input.usage),
        costUsd: existingWeek.costUsd + cost.total,
        chargeUsd: existingWeek.chargeUsd + chargeUsd,
        requestCount: existingWeek.requestCount + 1,
        ...latestTraceFields(input),
      });
    }
    if (input.debitsCreditBalance === true && input.ownerUid) {
      this.creditBalances.set(
        input.ownerUid,
        (this.creditBalances.get(input.ownerUid) ?? 0) - chargeUsd,
      );
    }
    if (input.signupOfferBudget) {
      const ledger = signupOfferLedger!;
      this.signupOfferBudgets.set(input.signupOfferBudget.budgetKey, {
        ...ledger,
        chargeUsd: ledger.chargeUsd + chargeUsd,
        requestCount: ledger.requestCount + 1,
        totalTokens: ledger.totalTokens + totalTokens(input.usage),
        updatedAt: now,
        expiresAt: new Date(now + SIGNUP_OFFER_LEDGER_RETENTION_MS),
      });
    }
  }

  async readCreditBalance(ownerUid: string): Promise<number> {
    return this.creditBalances.get(ownerUid) ?? 0;
  }

  async readSignupOfferBudget(
    input: SignupOfferBudgetIdentity & { budgetKey: string },
  ): Promise<ModelBrokerSignupOfferBudget | null> {
    return parseModelBrokerSignupOfferBudget(this.signupOfferBudgets.get(input.budgetKey), input);
  }

  async readWindowUsage(input: ModelBrokerUsageWindowReadInput): Promise<ModelBrokerUsageWindowSnapshot> {
    const now = input.now ?? Date.now();
    const windowStartMs = usageWindowStartMs(now);
    const ownerKey = windowOwnerKey(input);
    return (
      this.windows.get(windowDocId(ownerKey, windowStartMs)) ?? {
        ownerKey,
        windowStartMs,
        requestCount: 0,
        totalTokens: 0,
        costUsd: 0,
        chargeUsd: 0,
      }
    );
  }

  async readWeekUsage(input: ModelBrokerUsageWindowReadInput): Promise<ModelBrokerWeekSnapshot> {
    const now = input.now ?? Date.now();
    const weekStartMs = weekWindowStartMs(now);
    const ownerKey = windowOwnerKey(input);
    return (
      this.weekWindows.get(windowDocId(ownerKey, weekStartMs)) ?? {
        ownerKey,
        weekStartMs,
        requestCount: 0,
        totalTokens: 0,
        costUsd: 0,
        chargeUsd: 0,
      }
    );
  }

  async reserveRateWindow(input: ModelBrokerRateWindowReserveInput): Promise<ModelBrokerRateWindowSnapshot> {
    const now = input.now ?? Date.now();
    const windowStartMs = rateWindowStartMs(now);
    const ownerKey = rateWindowOwnerKey(input);
    const key = windowDocId(ownerKey, windowStartMs);
    const current = this.rateWindows.get(key) ?? {
      ownerKey,
      windowStartMs,
      requestCount: 0,
    };
    const next = { ...current, requestCount: current.requestCount + 1 };
    this.rateWindows.set(key, next);
    return next;
  }
}

interface UsageWriteArgs {
  input: ModelBrokerUsageRecordInput;
  cost: ModelBrokerUsageCost;
  chargeUsd: number;
  now: number;
  eventId: string;
  cacheWriteTtl: AnthropicCacheWriteTtl;
  ownerKey: string;
  modelKey: string;
  windowStartMs: number;
  weekStartMs: number;
  countsTowardWindow: boolean;
  refs: {
    eventRef: DocumentReference;
    rollupRef: DocumentReference;
    windowRef: DocumentReference;
    weekRef: DocumentReference;
    creditRef: DocumentReference | null;
    signupOfferRef: DocumentReference | null;
  };
  snaps: {
    rollup: DocumentData;
    window: DocumentData;
    week: DocumentData;
    credit: DocumentData;
    signupOffer: DocumentData;
  };
}

// The mutation half of the metering transaction. Kept separate from the reads so
// the reads-before-writes ordering the Firestore SDK requires is obvious, and so
// neither half individually trips the size/complexity ratchet.
function applyUsageWrites(t: Transaction, a: UsageWriteArgs): void {
  const { input, cost, chargeUsd, now, ownerKey, refs, snaps } = a;
  t.set(
    refs.eventRef,
    eventDocument({
      ...input,
      eventId: a.eventId,
      now,
      cacheWriteTtl: a.cacheWriteTtl,
      cost,
      chargeUsd,
      windowStartMs: a.windowStartMs,
    }),
  );
  t.set(
    refs.rollupRef,
    {
      ownerKey,
      gatewayId: input.gatewayId,
      ownerUid: input.ownerUid,
      provider: input.provider,
      updatedAt: now,
      ...latestTraceFields(input),
      ...usageDocumentTotals(snaps.rollup, input.usage, cost, chargeUsd),
      models: modelTotals({
        existing: snaps.rollup,
        modelKey: a.modelKey,
        model: input.model,
        provider: input.provider,
        usage: input.usage,
        cost,
        chargeUsd,
      }),
    },
    { merge: true },
  );
  if (a.countsTowardWindow) {
    t.set(
      refs.windowRef,
      {
        ownerKey,
        gatewayId: input.gatewayId,
        ownerUid: input.ownerUid,
        provider: input.provider,
        windowStartMs: a.windowStartMs,
        windowLengthHours: WINDOW_LENGTH_HOURS,
        updatedAt: now,
        expiresAt: expiresAt(now),
        ...latestTraceFields(input),
        ...usageDocumentTotals(snaps.window, input.usage, cost, chargeUsd),
      },
      { merge: true },
    );
    t.set(
      refs.weekRef,
      {
        ownerKey,
        gatewayId: input.gatewayId,
        ownerUid: input.ownerUid,
        provider: input.provider,
        weekStartMs: a.weekStartMs,
        windowLengthMs: MODEL_BROKER_WEEK_WINDOW_MS,
        updatedAt: now,
        expiresAt: expiresAt(now),
        ...latestTraceFields(input),
        ...usageDocumentTotals(snaps.week, input.usage, cost, chargeUsd),
      },
      { merge: true },
    );
  }
  if (refs.creditRef) {
    t.set(
      refs.creditRef,
      {
        ownerUid: input.ownerUid,
        balanceUsd: numberField(snaps.credit, "balanceUsd") - chargeUsd,
        updatedAt: now,
      },
      { merge: true },
    );
  }
  if (refs.signupOfferRef && input.signupOfferBudget) {
    const ledger = parseModelBrokerSignupOfferBudget(
      snaps.signupOffer,
      input.signupOfferBudget,
    );
    if (!ledger) {
      throw new Error("signup offer budget ledger missing or does not match the active receipt");
    }
    t.set(
      refs.signupOfferRef,
      {
        chargeUsd: ledger.chargeUsd + chargeUsd,
        requestCount: ledger.requestCount + 1,
        totalTokens: ledger.totalTokens + totalTokens(input.usage),
        updatedAt: now,
        expiresAt: new Date(now + SIGNUP_OFFER_LEDGER_RETENTION_MS),
      },
      { merge: true },
    );
  }
}

export function createFirestoreModelBrokerUsageStore(
  db: Pick<Firestore, "collection" | "runTransaction">,
): ModelBrokerUsageStore {
  return {
    async recordUsage(input) {
      const now = input.now ?? Date.now();
      const eventId = input.eventId ?? crypto.randomUUID();
      const cacheWriteTtl = input.cacheWriteTtl ?? "5m";
      const cost = resolveRecordedCost(input, cacheWriteTtl);
      const chargeUsd = resolvedChargeUsd(input, cost);
      const windowStartMs = usageWindowStartMs(now);
      const weekStartMs = weekWindowStartMs(now);
      const ownerKey = windowOwnerKey(input);
      const eventRef = db.collection(MODEL_BROKER_USAGE_EVENTS_COLLECTION).doc(eventId);
      const rollupRef = db.collection(MODEL_BROKER_USAGE_ROLLUPS_COLLECTION).doc(ownerKey);
      const windowRef = db
        .collection(MODEL_BROKER_USAGE_WINDOWS_COLLECTION)
        .doc(windowDocId(ownerKey, windowStartMs));
      const weekRef = db
        .collection(MODEL_BROKER_WEEK_WINDOWS_COLLECTION)
        .doc(windowDocId(ownerKey, weekStartMs));
      const debitsCredits = input.debitsCreditBalance === true && Boolean(input.ownerUid);
      const creditRef = debitsCredits
        ? db.collection(MODEL_BROKER_CREDITS_COLLECTION).doc(input.ownerUid as string)
        : null;
      const signupOfferRef = input.signupOfferBudget
        ? db.collection(MODEL_BROKER_SIGNUP_OFFER_BUDGETS_COLLECTION)
          .doc(input.signupOfferBudget.budgetKey)
        : null;
      const modelKey = modelRollupKey(input.model);

      const countsTowardWindow = input.countsTowardSpendWindow !== false;
      await db.runTransaction(async (t) => {
        const existingEvent = await t.get(eventRef);
        if (existingEvent.exists) return;
        const [rollupSnap, windowSnap, weekSnap, creditSnap, signupOfferSnap] = await Promise.all([
          t.get(rollupRef),
          t.get(windowRef),
          countsTowardWindow ? t.get(weekRef) : Promise.resolve(null),
          creditRef ? t.get(creditRef) : Promise.resolve(null),
          signupOfferRef ? t.get(signupOfferRef) : Promise.resolve(null),
        ]);
        applyUsageWrites(t, {
          input,
          cost,
          chargeUsd,
          now,
          eventId,
          cacheWriteTtl,
          ownerKey,
          modelKey,
          windowStartMs,
          weekStartMs,
          countsTowardWindow,
          refs: { eventRef, rollupRef, windowRef, weekRef, creditRef, signupOfferRef },
          snaps: {
            rollup: rollupSnap.data() ?? {},
            window: windowSnap.data() ?? {},
            week: weekSnap?.data() ?? {},
            credit: creditSnap?.data() ?? {},
            signupOffer: signupOfferSnap?.data() ?? {},
          },
        });
      });
    },

    async readWindowUsage(input) {
      const now = input.now ?? Date.now();
      const windowStartMs = usageWindowStartMs(now);
      const ownerKey = windowOwnerKey(input);
      const snap = await db
        .collection(MODEL_BROKER_USAGE_WINDOWS_COLLECTION)
        .doc(windowDocId(ownerKey, windowStartMs))
        .get();
      const data = snap.data() ?? {};
      return {
        ownerKey,
        windowStartMs,
        requestCount: numberField(data, "requestCount"),
        totalTokens: numberField(data, "totalTokens"),
        costUsd: numberField(data, "costUsd"),
        chargeUsd: chargeField(data),
      };
    },

    async readWeekUsage(input) {
      const now = input.now ?? Date.now();
      const weekStartMs = weekWindowStartMs(now);
      const ownerKey = windowOwnerKey(input);
      const snap = await db
        .collection(MODEL_BROKER_WEEK_WINDOWS_COLLECTION)
        .doc(windowDocId(ownerKey, weekStartMs))
        .get();
      const data = snap.data() ?? {};
      return {
        ownerKey,
        weekStartMs,
        requestCount: numberField(data, "requestCount"),
        totalTokens: numberField(data, "totalTokens"),
        costUsd: numberField(data, "costUsd"),
        chargeUsd: chargeField(data),
      };
    },

    async readCreditBalance(ownerUid) {
      const snap = await db.collection(MODEL_BROKER_CREDITS_COLLECTION).doc(ownerUid).get();
      return numberField((snap.data() ?? {}) as Record<string, unknown>, "balanceUsd");
    },

    async readSignupOfferBudget(input) {
      const snap = await db
        .collection(MODEL_BROKER_SIGNUP_OFFER_BUDGETS_COLLECTION)
        .doc(input.budgetKey)
        .get();
      const data = snap.data() as Record<string, unknown> | undefined;
      return parseModelBrokerSignupOfferBudget(data, input);
    },

    async reserveRateWindow(input) {
      const now = input.now ?? Date.now();
      const windowStartMs = rateWindowStartMs(now);
      const ownerKey = rateWindowOwnerKey(input);
      const rateRef = db
        .collection(MODEL_BROKER_RATE_WINDOWS_COLLECTION)
        .doc(windowDocId(ownerKey, windowStartMs));
      return db.runTransaction(async (t) => {
        const snap = await t.get(rateRef);
        const data = snap.data() ?? {};
        const requestCount = numberField(data, "requestCount") + 1;
        t.set(
          rateRef,
          {
            ownerKey,
            windowStartMs,
            windowLengthMs: MODEL_BROKER_RATE_WINDOW_MS,
            requestCount,
            updatedAt: now,
            expiresAt: expiresAt(now),
          },
          { merge: true },
        );
        return { ownerKey, windowStartMs, requestCount };
      });
    },
  };
}
