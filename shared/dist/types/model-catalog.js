// The platform model catalog: every model a plan with catalog access may run,
// per billing provider. Gateways boot model-ready against this list (both
// broker provider profiles per agent), so switching any agent to any entry is
// a pure config flip — no provisioning step. Plan policy (house_only vs
// catalog) is enforced at the LLM broker, never on the pod.
export const MODEL_CATALOG_PROVIDERS = ["anthropic", "openrouter", "openai"];
export const MODEL_REASONING_EFFORTS = ["high", "xhigh"];
export const MODEL_INPUT_MODALITIES = ["text", "image"];
export const MODEL_CATALOG = [
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
        provider: "openrouter",
        id: "z-ai/glm-5.2",
        label: "GLM 5.2",
        source: "openrouter",
        contextTokens: 1_048_576,
        reasoningEfforts: ["high", "xhigh"],
        defaultReasoningEffort: "xhigh",
    },
    {
        provider: "openrouter",
        id: "minimax/minimax-m3",
        label: "MiniMax M3",
        source: "openrouter",
        contextTokens: 524_288,
        reasoningEfforts: [],
    },
    {
        provider: "openrouter",
        id: "deepseek/deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        source: "openrouter",
        contextTokens: 1_048_576,
        reasoningEfforts: [],
    },
    {
        provider: "openrouter",
        id: "openai/gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        source: "openrouter",
        contextTokens: 1_050_000,
        input: ["text", "image"],
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
