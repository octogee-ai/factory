import { catalogEntryForModelRef } from "./agent-models.js";
// Operator dials for platform-wide model policy, stored at platformConfig/models
// (server-only collection; admin reads/writes go through the API). Absent or
// invalid doc → the compiled default below, so the free tier always has a
// resolvable house pin.
export const PLATFORM_CONFIG_COLLECTION = "platformConfig";
export const PLATFORM_MODEL_CONFIG_DOC = "models";
// The free-tier house model: DeepSeek V4 Pro on the OpenRouter platform key
// (operator default 2026-07-08; the dial can point anywhere in the catalog).
export const DEFAULT_FREE_TIER_MODEL_REF = "platform-openrouter/deepseek/deepseek-v4-pro";
export function parsePlatformModelConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const ref = value.freeTierModelRef;
    if (typeof ref !== "string" || resolveFreeTierModel(ref) === null)
        return null;
    return { freeTierModelRef: ref };
}
// Split a catalog model ref into what each dial consumer needs: the broker
// provider profile the traffic rides, and the model id the upstream API
// accepts (anthropic entries are catalog-prefixed; the wire wants the bare id).
export function resolveFreeTierModel(ref) {
    const entry = catalogEntryForModelRef(ref);
    if (!entry)
        return null;
    return {
        ref,
        provider: entry.provider,
        upstreamModelId: entry.provider === "anthropic" ? entry.id.replace(/^anthropic\//, "") : entry.id,
    };
}
