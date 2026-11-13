import type { ModelCatalogEntry, ModelTokenPricing } from "./model-catalog.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function price(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return undefined;
  const perMillion = Number(value) * 1_000_000;
  return Number.isFinite(perMillion) ? perMillion : undefined;
}

function tokenPricing(value: unknown): ModelTokenPricing | undefined {
  const data = record(value);
  const inputPerMTok = price(data.prompt);
  const outputPerMTok = price(data.completion);
  if (inputPerMTok === undefined || outputPerMTok === undefined) return undefined;
  return {
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok: price(data.input_cache_read) ?? inputPerMTok,
    cacheWritePerMTok: price(data.input_cache_write) ?? inputPerMTok,
  };
}

function validModelIdentity(
  data: Record<string, unknown>,
  today: string,
): data is Record<string, unknown> & { id: string; name: string; context_length: number } {
  return typeof data.id === "string" && data.id.length <= 108 &&
    /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(data.id) &&
    !data.id.endsWith(":batch") && positiveInteger(data.context_length) &&
    typeof data.name === "string" && data.name.trim().length > 0 &&
    !(typeof data.expiration_date === "string" && data.expiration_date <= today);
}

function modelEntry(value: unknown, today: string): ModelCatalogEntry | null {
  const data = record(value);
  const architecture = record(data.architecture);
  const parameters = Array.isArray(data.supported_parameters) ? data.supported_parameters : [];
  const inputs = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
  const outputs = architecture.output_modalities;
  if (!validModelIdentity(data, today) || !parameters.includes("tools") ||
      !inputs.includes("text") || !Array.isArray(outputs) ||
      outputs.length !== 1 || outputs[0] !== "text") return null;
  const maxOutput = record(data.top_provider).max_completion_tokens;
  const pricing = tokenPricing(data.pricing);
  const overrides = record(data.pricing).overrides;
  const pricingOverrides = Array.isArray(overrides) ? overrides.flatMap((value) => {
    const rule = record(value);
    if (!positiveInteger(rule.min_prompt_tokens) || !Object.keys(rule).every((key) =>
      ["min_prompt_tokens", "prompt", "completion", "input_cache_read", "input_cache_write"].includes(key))) return [];
    const rates = Object.fromEntries([
      ["inputPerMTok", price(rule.prompt)], ["outputPerMTok", price(rule.completion)],
      ["cacheReadPerMTok", price(rule.input_cache_read)], ["cacheWritePerMTok", price(rule.input_cache_write)],
    ].filter(([, rate]) => rate !== undefined));
    return [{ ...rates, aboveInputTokens: rule.min_prompt_tokens }];
  }) : [];
  const reasoning = record(data.reasoning);
  const efforts = Array.isArray(reasoning.supported_efforts) ? reasoning.supported_efforts : [];
  return {
    provider: "openrouter",
    id: data.id,
    label: data.name.replace(/^[^:]+: /, "").trim(),
    source: "openrouter",
    contextTokens: data.context_length,
    input: inputs.includes("image") ? ["text", "image"] : ["text"],
    ...(positiveInteger(maxOutput) ? { maxOutputTokens: Math.min(maxOutput, data.context_length) } : {}),
    reasoning: parameters.includes("reasoning"),
    reasoningEfforts: ["high", "xhigh"].filter((effort): effort is "high" | "xhigh" => efforts.includes(effort)),
    ...(pricing ? { pricing } : {}),
    ...(pricingOverrides.length ? { pricingOverrides } : {}),
  };
}

export function parseOpenRouterCatalog(
  value: unknown,
  today = new Date().toISOString().slice(0, 10),
): ModelCatalogEntry[] {
  const data = record(value).data;
  if (!Array.isArray(data)) throw new Error("OpenRouter models response must contain a data array");
  const entries = data.flatMap((model) => {
    const entry = modelEntry(model, today);
    return entry ? [entry] : [];
  });
  if (entries.length === 0) throw new Error("OpenRouter returned no compatible agent models");
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error("OpenRouter returned duplicate model IDs");
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id, "en"));
}
