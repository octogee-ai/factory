import {
  anonymousOperationalEnvironment,
  anonymousOperationalGatewayClass,
  anonymousOperationalPlanTier,
  isAnonymousOperationalModelDimension,
} from "@octogee/shared/types/account-lifecycle";

interface DeletionArchiveInput {
  archivedAt: number;
  createdAt: number | null;
  deletionRequestedAt: number;
  environment: string;
  planTier: string | null;
  gatewayClass: string | null;
  rollup: Record<string, unknown>;
}

interface AnonymousModelAggregate {
  provider: string;
  model: string;
  costUsd: number;
  totalTokens: number;
  requestCount: number;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function month(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return new Date(value).toISOString().slice(0, 7);
}

function canonicalModelDimension(
  providerValue: unknown,
  modelValue: unknown,
  billingModelValue: unknown,
): { provider: string; model: string } {
  const provider = typeof providerValue === "string" ? providerValue : "unknown";
  if (isAnonymousOperationalModelDimension(provider, billingModelValue)) {
    return { provider, model: billingModelValue as string };
  }
  const raw = typeof modelValue === "string" ? modelValue.toLowerCase() : "";
  let model = "unknown";
  if (provider === "anthropic") {
    if (raw.includes("fable")) model = "fable";
    else if (raw.includes("mythos")) model = "mythos";
    else if (raw.includes("sonnet")) model = "sonnet";
    else if (raw.includes("haiku-3-5") || raw.includes("haiku-3.5")) model = "haiku-3.5";
    else if (raw.includes("haiku")) model = "haiku-4.5";
    else if (raw.includes("opus-4-1") || raw.includes("opus-4-0")) model = "opus-legacy";
    else if (raw.includes("opus")) model = "opus-latest";
    else model = "unknown-fable-fallback";
  } else if (provider === "openrouter") {
    model = raw === "z-ai/glm-5.2" || raw === "deepseek/deepseek-v4-pro"
      ? `openrouter:${raw}`
      : "openrouter:unknown-fallback";
  } else if (provider === "openai") {
    model = raw.startsWith("gpt-5.4-mini")
      ? "openai:gpt-5.4-mini"
      : "openai:unknown-fallback";
  } else if (provider === "brave") {
    model = raw === "brave/web-search" ? raw : "brave/unknown";
  } else if (provider === "tavily") {
    model = [
      "tavily/search-basic",
      "tavily/search-advanced",
      "tavily/extract-basic",
      "tavily/extract-advanced",
    ].includes(raw) ? raw : "tavily/unknown";
  }
  return isAnonymousOperationalModelDimension(provider, model)
    ? { provider, model }
    : { provider: "unknown", model: "unknown" };
}

function modelAggregates(rollup: Record<string, unknown>): AnonymousModelAggregate[] {
  const source = rollup.models;
  if (!source || typeof source !== "object" || Array.isArray(source)) return [];
  const aggregates = new Map<string, AnonymousModelAggregate>();
  for (const raw of Object.values(source as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const data = raw as Record<string, unknown>;
    const dimension = canonicalModelDimension(
      data.provider ?? rollup.provider,
      data.model,
      data.billingModel,
    );
    const key = `${dimension.provider}:${dimension.model}`;
    const current = aggregates.get(key) ?? {
      ...dimension,
      costUsd: 0,
      totalTokens: 0,
      requestCount: 0,
    };
    current.costUsd += nonNegative(data.costUsd);
    current.totalTokens += nonNegative(data.totalTokens);
    current.requestCount += nonNegative(data.requestCount);
    aggregates.set(key, current);
  }
  return Array.from(aggregates.values()).sort((a, b) =>
    `${a.provider}:${a.model}`.localeCompare(`${b.provider}:${b.model}`));
}

export function buildAnonymousOperationalArchive(input: DeletionArchiveInput) {
  return {
    schemaVersion: 1,
    archivedAt: input.archivedAt,
    accountCreatedMonth: month(input.createdAt),
    deletionRequestedMonth: month(input.deletionRequestedAt),
    environment: anonymousOperationalEnvironment(input.environment),
    planTier: anonymousOperationalPlanTier(input.planTier),
    gatewayClass: anonymousOperationalGatewayClass(input.gatewayClass),
    totals: {
      costUsd: nonNegative(input.rollup.costUsd),
      totalTokens: nonNegative(input.rollup.totalTokens),
      requestCount: nonNegative(input.rollup.requestCount),
    },
    models: modelAggregates(input.rollup),
  };
}
