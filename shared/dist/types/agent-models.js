import { MODEL_CATALOG } from "./model-catalog.js";
export const MAX_AGENT_MODEL_FALLBACKS = 3;
const MODEL_REF_PATTERN = /^[a-z0-9][a-z0-9._:-]*(\/[a-z0-9][a-z0-9._:-]*){1,2}$/i;
const MAX_MODEL_REF_LENGTH = 128;
const AGENT_ID_PATTERN = /^octogee-[a-z0-9][a-z0-9-]*-coach$/;
export const OPENROUTER_PLATFORM_PROVIDER_ID = "platform-openrouter";
export const OPENAI_PLATFORM_PROVIDER_ID = "platform-openai";
export function isValidModelRef(value) {
    return (typeof value === "string" &&
        value.length <= MAX_MODEL_REF_LENGTH &&
        MODEL_REF_PATTERN.test(value));
}
export function modelRefForCatalogEntry(entry) {
    if (entry.provider === "openrouter")
        return `${OPENROUTER_PLATFORM_PROVIDER_ID}/${entry.id}`;
    if (entry.provider === "openai")
        return `${OPENAI_PLATFORM_PROVIDER_ID}/${entry.id}`;
    return entry.id;
}
export function platformModelRefs() {
    return MODEL_CATALOG.map(modelRefForCatalogEntry);
}
export function catalogEntryForModelRef(ref) {
    return MODEL_CATALOG.find((entry) => modelRefForCatalogEntry(entry) === ref) ?? null;
}
export function parseAgentModelSelection(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const { primary, fallbacks } = value;
    if (!isValidModelRef(primary))
        return null;
    if (fallbacks === undefined)
        return { primary, fallbacks: [] };
    if (!Array.isArray(fallbacks) || fallbacks.length > MAX_AGENT_MODEL_FALLBACKS)
        return null;
    if (!fallbacks.every(isValidModelRef))
        return null;
    return { primary, fallbacks: [...fallbacks] };
}
export function parseAgentModelSelections(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    const out = {};
    for (const [agentId, selection] of Object.entries(value)) {
        if (!AGENT_ID_PATTERN.test(agentId))
            continue;
        const parsed = parseAgentModelSelection(selection);
        if (parsed)
            out[agentId] = parsed;
    }
    return out;
}
export function agentIdBelongsToSlug(agentId, slug) {
    if (agentId === `octogee-${slug}-coach`)
        return true;
    const projPrefix = `octogee-${slug}-proj-`;
    return (AGENT_ID_PATTERN.test(agentId) && agentId.startsWith(projPrefix) && agentId.endsWith("-coach"));
}
export function canonicalCustomerModelDefinition(modelRef) {
    const popularAliases = {
        "platform-openai/gpt-6-astra": "astra",
        "platform-openrouter/openai/gpt-6-astra": "astra-openrouter",
        "anthropic/claude-opus-5": "opus",
        "anthropic/claude-fable-5-1": "fable",
        "platform-openrouter/x-ai/grok-4.6": "grok",
        "platform-openrouter/google/gemini-3.8-flash": "gemini",
    };
    if (popularAliases[modelRef])
        return { alias: popularAliases[modelRef] };
    if (modelRef === "platform-openrouter/deepseek/deepseek-v4-pro") {
        return { alias: "deepseek" };
    }
    if (modelRef === "platform-openrouter/z-ai/glm-5.2") {
        return { alias: "glm", params: { thinking: "xhigh" } };
    }
    if (modelRef === "anthropic/claude-sonnet-4-6") {
        return { alias: "sonnet", params: { cacheRetention: "short" } };
    }
    if (modelRef === "anthropic/claude-haiku-4-5") {
        return { alias: "haiku", params: { cacheRetention: "short" } };
    }
    return {};
}
