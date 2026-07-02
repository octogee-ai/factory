import * as crypto from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

import { WINDOW_LENGTH_HOURS } from "@octogee/shared/types/billing";
import {
  MODEL_BROKER_HOUSE_DAY_WINDOW_MS,
  MODEL_BROKER_HOUSE_DAY_WINDOWS_COLLECTION,
  MODEL_BROKER_USAGE_EVENTS_COLLECTION,
  MODEL_BROKER_USAGE_ROLLUPS_COLLECTION,
  MODEL_BROKER_USAGE_WINDOWS_COLLECTION,
  MODEL_BROKER_RATE_WINDOWS_COLLECTION,
  MODEL_BROKER_RATE_WINDOW_MS,
  houseDayStartMs,
  modelBrokerWindowDocId as windowDocId,
  rateWindowStartMs,
  usageWindowStartMs,
  windowOwnerKey,
} from "@octogee/shared/types/model-broker-usage";

export type ModelBrokerUsageProvider = "anthropic" | "openrouter";
export type AnthropicCacheWriteTtl = "5m" | "1h";

export interface AnthropicTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface ModelBrokerUsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  pricingModel: string;
  cacheWriteTtl: AnthropicCacheWriteTtl;
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
}

export interface ModelBrokerUsageStore {
  recordUsage(input: ModelBrokerUsageRecordInput): Promise<void>;
  readWindowUsage?(input: ModelBrokerUsageWindowReadInput): Promise<ModelBrokerUsageWindowSnapshot>;
  reserveRateWindow?(input: ModelBrokerRateWindowReserveInput): Promise<ModelBrokerRateWindowSnapshot>;
  readHouseDayUsage?(input: ModelBrokerUsageWindowReadInput): Promise<ModelBrokerHouseDaySnapshot>;
}

export interface ModelBrokerHouseDaySnapshot {
  ownerKey: string;
  dayStartMs: number;
  requestCount: number;
  totalTokens: number;
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
}

export interface ModelBrokerRateWindowReserveInput {
  gatewayId: string;
  ownerUid?: string | null;
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
const OPENROUTER_PRICING: Record<string, AnthropicPricing> = {
  "z-ai/glm-5.2": pricing(0.94, 3, "openrouter:z-ai/glm-5.2"),
};
const UNKNOWN_OPENROUTER_FALLBACK_PRICING = pricing(1, 5, "openrouter:unknown-fallback");

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
  };
}

function openRouterModelPricing(model: string): AnthropicPricing {
  const normalized = model.toLowerCase();
  return OPENROUTER_PRICING[normalized] ?? UNKNOWN_OPENROUTER_FALLBACK_PRICING;
}

export function estimateModelBrokerCost(
  provider: ModelBrokerUsageProvider,
  model: string,
  usage: AnthropicTokenUsage,
  cacheWriteTtl: AnthropicCacheWriteTtl = "5m",
): ModelBrokerUsageCost {
  if (provider === "anthropic") return estimateAnthropicCost(model, usage, cacheWriteTtl);
  const prices = openRouterModelPricing(model);
  return {
    input: usd(usage.inputTokens + usage.cacheCreationInputTokens, prices.inputPerMTok),
    output: usd(usage.outputTokens, prices.outputPerMTok),
    cacheRead: usd(usage.cacheReadInputTokens, prices.inputPerMTok),
    cacheWrite: 0,
    total:
      usd(usage.inputTokens + usage.cacheCreationInputTokens, prices.inputPerMTok) +
      usd(usage.outputTokens, prices.outputPerMTok) +
      usd(usage.cacheReadInputTokens, prices.inputPerMTok),
    pricingModel: prices.pricingModel,
    cacheWriteTtl,
  };
}

export function isUnknownOpenRouterPricingModel(pricingModel: string): boolean {
  return pricingModel === UNKNOWN_OPENROUTER_FALLBACK_PRICING.pricingModel;
}

export function modelRollupKey(model: string): string {
  return model.replace(/[/.]/g, "_").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) || "unknown";
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

function addUsageFields(
  existing: Record<string, unknown>,
  usage: AnthropicTokenUsage,
  cost: ModelBrokerUsageCost,
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
): Record<string, unknown> {
  const totals = addUsageFields(existing, usage, cost);
  return {
    requestCount: totals.requestCount,
    totalTokens: totals.totalTokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheCreationInputTokens: totals.cacheCreationInputTokens,
    cacheReadInputTokens: totals.cacheReadInputTokens,
    costUsd: totals.costUsd,
    costBreakdown: {
      input: totals.costInput,
      output: totals.costOutput,
      cacheRead: totals.costCacheRead,
      cacheWrite: totals.costCacheWrite,
    },
  };
}

function modelTotals(
  existing: Record<string, unknown>,
  modelKey: string,
  model: string,
  usage: AnthropicTokenUsage,
  cost: ModelBrokerUsageCost,
): Record<string, unknown> {
  const models = asRecord(existing.models);
  const current = asRecord(models[modelKey]);
  return {
    ...models,
    [modelKey]: {
      model,
      totalTokens: numberField(current, "totalTokens") + totalTokens(usage),
      costUsd: numberField(current, "costUsd") + cost.total,
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
    costBreakdown: {
      input: input.cost.input,
      output: input.cost.output,
      cacheRead: input.cost.cacheRead,
      cacheWrite: input.cost.cacheWrite,
    },
    pricing: {
      model: input.cost.pricingModel,
      cacheWriteTtl: input.cacheWriteTtl,
    },
  };
}

export class InMemoryModelBrokerUsageStore implements ModelBrokerUsageStore {
  readonly events: Array<Record<string, unknown>> = [];
  readonly rollups = new Map<string, Record<string, unknown> & { totalTokens: number; costUsd: number; requestCount: number }>();
  readonly windows = new Map<string, ModelBrokerUsageWindowSnapshot & Record<string, unknown>>();
  readonly rateWindows = new Map<string, ModelBrokerRateWindowSnapshot>();
  readonly houseDayWindows = new Map<string, ModelBrokerHouseDaySnapshot>();
  private readonly eventIds = new Set<string>();

  async recordUsage(input: ModelBrokerUsageRecordInput): Promise<void> {
    const now = input.now ?? Date.now();
    const cacheWriteTtl = input.cacheWriteTtl ?? "5m";
    const cost = estimateModelBrokerCost(input.provider, input.model, input.usage, cacheWriteTtl);
    const eventId = input.eventId ?? crypto.randomUUID();
    if (this.eventIds.has(eventId)) return;
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
        windowStartMs,
      }),
    );
    const existing = this.rollups.get(ownerKey) ?? {
      totalTokens: 0,
      costUsd: 0,
      requestCount: 0,
    };
    this.rollups.set(ownerKey, {
      totalTokens: existing.totalTokens + totalTokens(input.usage),
      costUsd: existing.costUsd + cost.total,
      requestCount: existing.requestCount + 1,
      ...latestTraceFields(input),
    });
    if (input.countsTowardSpendWindow !== false) {
      const windowKey = windowDocId(ownerKey, windowStartMs);
      const existingWindow = this.windows.get(windowKey) ?? {
        ownerKey,
        windowStartMs,
        totalTokens: 0,
        costUsd: 0,
        requestCount: 0,
      };
      this.windows.set(windowKey, {
        ownerKey,
        windowStartMs,
        totalTokens: existingWindow.totalTokens + totalTokens(input.usage),
        costUsd: existingWindow.costUsd + cost.total,
        requestCount: existingWindow.requestCount + 1,
        ...latestTraceFields(input),
      });
    }
    if (input.degraded === true) {
      const dayStartMs = houseDayStartMs(now);
      const dayKey = windowDocId(ownerKey, dayStartMs);
      const existingDay = this.houseDayWindows.get(dayKey) ?? {
        ownerKey,
        dayStartMs,
        totalTokens: 0,
        requestCount: 0,
      };
      this.houseDayWindows.set(dayKey, {
        ownerKey,
        dayStartMs,
        totalTokens: existingDay.totalTokens + totalTokens(input.usage),
        requestCount: existingDay.requestCount + 1,
      });
    }
  }

  async readHouseDayUsage(input: ModelBrokerUsageWindowReadInput): Promise<ModelBrokerHouseDaySnapshot> {
    const now = input.now ?? Date.now();
    const dayStartMs = houseDayStartMs(now);
    const ownerKey = windowOwnerKey(input);
    return (
      this.houseDayWindows.get(windowDocId(ownerKey, dayStartMs)) ?? {
        ownerKey,
        dayStartMs,
        requestCount: 0,
        totalTokens: 0,
      }
    );
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
      }
    );
  }

  async reserveRateWindow(input: ModelBrokerRateWindowReserveInput): Promise<ModelBrokerRateWindowSnapshot> {
    const now = input.now ?? Date.now();
    const windowStartMs = rateWindowStartMs(now);
    const ownerKey = windowOwnerKey(input);
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

export function createFirestoreModelBrokerUsageStore(
  db: Pick<Firestore, "collection" | "runTransaction">,
): ModelBrokerUsageStore {
  return {
    async recordUsage(input) {
      const now = input.now ?? Date.now();
      const eventId = input.eventId ?? crypto.randomUUID();
      const cacheWriteTtl = input.cacheWriteTtl ?? "5m";
      const cost = estimateModelBrokerCost(input.provider, input.model, input.usage, cacheWriteTtl);
      const windowStartMs = usageWindowStartMs(now);
      const ownerKey = windowOwnerKey(input);
      const dayStartMs = houseDayStartMs(now);
      const eventRef = db.collection(MODEL_BROKER_USAGE_EVENTS_COLLECTION).doc(eventId);
      const rollupRef = db.collection(MODEL_BROKER_USAGE_ROLLUPS_COLLECTION).doc(ownerKey);
      const windowRef = db
        .collection(MODEL_BROKER_USAGE_WINDOWS_COLLECTION)
        .doc(windowDocId(ownerKey, windowStartMs));
      const houseDayRef = db
        .collection(MODEL_BROKER_HOUSE_DAY_WINDOWS_COLLECTION)
        .doc(windowDocId(ownerKey, dayStartMs));
      const modelKey = modelRollupKey(input.model);

      await db.runTransaction(async (t) => {
        const existingEvent = await t.get(eventRef);
        if (existingEvent.exists) return;
        const [rollupSnap, windowSnap, houseDaySnap] = await Promise.all([
          t.get(rollupRef),
          t.get(windowRef),
          input.degraded === true ? t.get(houseDayRef) : Promise.resolve(null),
        ]);
        const rollupData = rollupSnap.data() ?? {};
        const windowData = windowSnap.data() ?? {};
        const houseDayData = houseDaySnap?.data() ?? {};

        t.set(
          eventRef,
          eventDocument({
            ...input,
            eventId,
            now,
            cacheWriteTtl,
            cost,
            windowStartMs,
          }),
        );
        t.set(
          rollupRef,
          {
            ownerKey,
            gatewayId: input.gatewayId,
            ownerUid: input.ownerUid,
            provider: input.provider,
            updatedAt: now,
            ...latestTraceFields(input),
            ...usageDocumentTotals(rollupData, input.usage, cost),
            models: modelTotals(rollupData, modelKey, input.model, input.usage, cost),
          },
          { merge: true },
        );
        if (input.countsTowardSpendWindow !== false) {
          t.set(
            windowRef,
            {
              ownerKey,
              gatewayId: input.gatewayId,
              ownerUid: input.ownerUid,
              provider: input.provider,
              windowStartMs,
              windowLengthHours: WINDOW_LENGTH_HOURS,
              updatedAt: now,
              expiresAt: expiresAt(now),
              ...latestTraceFields(input),
              ...usageDocumentTotals(windowData, input.usage, cost),
            },
            { merge: true },
          );
        }
        if (input.degraded === true) {
          t.set(
            houseDayRef,
            {
              ownerKey,
              gatewayId: input.gatewayId,
              ownerUid: input.ownerUid,
              dayStartMs,
              windowLengthMs: MODEL_BROKER_HOUSE_DAY_WINDOW_MS,
              updatedAt: now,
              expiresAt: expiresAt(now),
              requestCount: numberField(houseDayData, "requestCount") + 1,
              totalTokens: numberField(houseDayData, "totalTokens") + totalTokens(input.usage),
            },
            { merge: true },
          );
        }
      });
    },

    async readHouseDayUsage(input) {
      const now = input.now ?? Date.now();
      const dayStartMs = houseDayStartMs(now);
      const ownerKey = windowOwnerKey(input);
      const snap = await db
        .collection(MODEL_BROKER_HOUSE_DAY_WINDOWS_COLLECTION)
        .doc(windowDocId(ownerKey, dayStartMs))
        .get();
      const data = snap.data() ?? {};
      return {
        ownerKey,
        dayStartMs,
        requestCount: numberField(data, "requestCount"),
        totalTokens: numberField(data, "totalTokens"),
      };
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
      };
    },

    async reserveRateWindow(input) {
      const now = input.now ?? Date.now();
      const windowStartMs = rateWindowStartMs(now);
      const ownerKey = windowOwnerKey(input);
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
