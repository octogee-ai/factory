import { OPENROUTER_MODEL_CATALOG } from "./openrouter-model-catalog.generated.js";
export const MODEL_CATALOG_PROVIDERS = ["anthropic", "openrouter", "openai"];
export const MODEL_REASONING_EFFORTS = ["high", "xhigh"];
export const MODEL_INPUT_MODALITIES = ["text", "image"];
const DIRECT_MODEL_CATALOG = [
    ...[
        ["claude-fable-5-1", "Claude Fable 5.1"],
        ["claude-opus-5", "Claude Opus 5"],
        ["claude-sonnet-5", "Claude Sonnet 5"],
        ["claude-opus-4-8", "Claude Opus 4.8"],
    ].map(([id, label]) => ({
        provider: "anthropic", id: `anthropic/${id}`, label, source: "openclaw-release",
        aliases: [id], contextTokens: 1_000_000, input: ["text", "image"],
        reasoningEfforts: ["high"],
    })),
    {
        provider: "anthropic",
        id: "anthropic/claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        source: "openclaw-release",
        aliases: ["claude-sonnet-4-6"],
        reasoningEfforts: [],
    },
    {
        provider: "anthropic",
        id: "anthropic/claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        source: "openclaw-release",
        aliases: ["claude-haiku-4-5"],
        reasoningEfforts: [],
    },
    {
        provider: "openai",
        id: "gpt-6-astra",
        label: "GPT-6 Astra",
        source: "openai",
        contextTokens: 1_050_000,
        maxOutputTokens: 128_000,
        input: ["text", "image"],
        reasoning: true,
        pricing: { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 1.0, cacheWritePerMTok: 12.5 },
        pricingOverrides: [{ aboveInputTokens: 272_000, inputPerMTok: 20, outputPerMTok: 75.0, cacheReadPerMTok: 2.0, cacheWritePerMTok: 25.0 }],
        reasoningEfforts: ["high", "xhigh"],
    },
    {
        provider: "openai",
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        source: "openai",
        contextTokens: 1_050_000,
        maxOutputTokens: 128_000,
        input: ["text", "image"],
        reasoning: true,
        pricing: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.4, cacheWritePerMTok: 5.0 },
        pricingOverrides: [{ aboveInputTokens: 272_000, inputPerMTok: 8, outputPerMTok: 30.0, cacheReadPerMTok: 0.8, cacheWritePerMTok: 10.0 }],
        reasoningEfforts: ["high", "xhigh"],
    },
    {
        provider: "openai",
        id: "gpt-5.6-terra",
        label: "GPT-5.6 Terra",
        source: "openai",
        contextTokens: 1_050_000,
        maxOutputTokens: 128_000,
        input: ["text", "image"],
        reasoning: true,
        pricing: { inputPerMTok: 2, outputPerMTok: 12, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
        pricingOverrides: [{ aboveInputTokens: 272_000, inputPerMTok: 4, outputPerMTok: 18.0, cacheReadPerMTok: 0.4, cacheWritePerMTok: 5.0 }],
        reasoningEfforts: ["high", "xhigh"],
    },
    {
        provider: "openai",
        id: "gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        source: "openai",
        contextTokens: 1_050_000,
        maxOutputTokens: 128_000,
        input: ["text", "image"],
        reasoning: true,
        pricing: { inputPerMTok: 0.2, outputPerMTok: 1.2, cacheReadPerMTok: 0.02, cacheWritePerMTok: 0.25 },
        pricingOverrides: [{ aboveInputTokens: 272_000, inputPerMTok: 0.4, outputPerMTok: 1.8, cacheReadPerMTok: 0.04, cacheWritePerMTok: 0.5 }],
        reasoningEfforts: ["high", "xhigh"],
    },
    {
        provider: "openai",
        id: "gpt-5.4-mini",
        label: "GPT-5.4 Mini",
        source: "openai",
        contextTokens: 400_000,
        input: ["text", "image"],
        reasoningEfforts: [],
    },
];
export const MODEL_CATALOG = [
    ...DIRECT_MODEL_CATALOG,
    ...OPENROUTER_MODEL_CATALOG
        .filter((entry) => entry.id !== "google/gemini-3.1-flash-lite-preview")
        .map((entry) => entry.id === "z-ai/glm-5.2"
        ? { ...entry, reasoningEfforts: ["high", "xhigh"], defaultReasoningEffort: "xhigh" }
        : entry),
];
export function isModelCatalogProvider(value) {
    return value === "anthropic" || value === "openrouter" || value === "openai";
}
export function isModelReasoningEffort(value) {
    return value === "high" || value === "xhigh";
}
export function modelCatalogForProvider(provider) {
    return MODEL_CATALOG.filter((entry) => entry.provider === provider);
}
export function modelCatalogEntryFor(provider, model) {
    return MODEL_CATALOG.find((entry) => entry.provider === provider &&
        (entry.id === model || Boolean(entry.aliases?.includes(model)))) ?? null;
}
