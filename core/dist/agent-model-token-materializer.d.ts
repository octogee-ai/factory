export declare const OPENROUTER_BROKER_PROVIDER_ID = "platform-openrouter";
export declare const OPENROUTER_BROKER_PROFILE_ID = "platform-openrouter:default";
export declare const OPENAI_BROKER_PROVIDER_ID = "platform-openai";
export declare const OPENAI_BROKER_PROFILE_ID = "platform-openai:default";
export interface AnthropicBrokerProfileEntry {
    type: "api_key";
    provider: "anthropic";
    keyRef: {
        source: "exec";
        provider: string;
        id: string;
    };
}
export interface OpenRouterBrokerProfileEntry {
    type: "api_key";
    provider: typeof OPENROUTER_BROKER_PROVIDER_ID;
    keyRef: {
        source: "exec";
        provider: string;
        id: string;
    };
}
export type AgentModelBrokerProvider = "anthropic" | "openrouter" | "openai";
export interface OpenRouterBrokerModelInput {
    baseUrl: string;
    model: string;
    contextTokens?: number;
}
export interface OpenRouterBrokerProviderConfigInput extends OpenRouterBrokerModelInput {
    apiKey: string;
}
export interface OpenRouterBrokerProviderConfig {
    api: "openai-completions";
    baseUrl: string;
    apiKey: string;
    models: Array<{
        id: string;
        name: string;
        contextTokens?: number;
        contextWindow?: number;
    }>;
}
export interface OpenRouterBrokerModelsJson {
    providers: Record<string, {
        api: "openai-completions";
        baseUrl: string;
        apiKey: string;
        models: Array<{
            id: string;
            name: string;
            contextTokens?: number;
            contextWindow?: number;
        }>;
    }>;
}
export declare function agentModelTokenSecretId(agentId: string, provider?: AgentModelBrokerProvider): string;
export declare function openRouterBrokerProviderConfig(input: OpenRouterBrokerProviderConfigInput): OpenRouterBrokerProviderConfig;
export declare function agentModelTokenProfileEntry(agentId: string): AnthropicBrokerProfileEntry;
export declare function openRouterBrokerProfileEntry(agentId: string): OpenRouterBrokerProfileEntry;
export interface OpenAiBrokerProfileEntry {
    type: "api_key";
    provider: typeof OPENAI_BROKER_PROVIDER_ID;
    keyRef: {
        source: "exec";
        provider: string;
        id: string;
    };
}
export declare function openAiBrokerProfileEntry(agentId: string): OpenAiBrokerProfileEntry;
export declare function openRouterBrokerModelsJson(agentId: string, input: OpenRouterBrokerModelInput): OpenRouterBrokerModelsJson;
export interface OpenRouterBrokerCatalogInput {
    baseUrl: string;
    models: Array<Pick<OpenRouterBrokerModelInput, "model" | "contextTokens">>;
}
export declare function openRouterCatalogInputForBaseUrl(baseUrl: string): OpenRouterBrokerCatalogInput;
export declare function openAiCatalogInputForBaseUrl(baseUrl: string): OpenRouterBrokerCatalogInput;
export declare function openRouterBrokerCatalogJson(_agentId: string, input: OpenRouterBrokerCatalogInput): OpenRouterBrokerModelsJson;
/**
 * Upsert the per-agent broker-token `anthropic:default` profile, MERGING into the
 * agent's existing auth-profile store.
 *
 * The store is last-writer-wins on a single JSON blob, and a byosub OAuth profile
 * (openai-codex / anthropic:claude-cli) may already be the agent's PRIMARY — so we
 * read-merge-write to add anthropic:default without clobbering it, and preserve the
 * store's top-level (e.g. an OAuth store's `version`). anthropic:default is always
 * the broker token here: it is the platform/anthropic-BYOK primary for plain
 * customers and the Haiku-fallback credential for BYOS/non-anthropic-BYOK ones.
 *
 * Idempotent — returns false (no write) when the desired profile is already present.
 */
export declare function upsertAnthropicBrokerProfile(agentDir: string, agentId: string): boolean;
export declare function upsertOpenRouterBrokerProfile(agentDir: string, agentId: string): boolean;
export declare function upsertOpenAiBrokerProfile(agentDir: string, agentId: string): boolean;
/** A catalog upsert splits into two independent surfaces: `models.json` (plain
 *  filesystem, always writable) and the auth-profile store (sqlite, which only
 *  openclaw creates). `profileDeferred` marks the second one as not-yet-possible
 *  so a later sweep retries it — never as failed. */
export interface PlatformBrokerCatalogResult {
    wrote: boolean;
    profileDeferred: boolean;
}
export declare function upsertOpenRouterBrokerModel(agentDir: string, agentId: string, input: OpenRouterBrokerModelInput): PlatformBrokerCatalogResult;
export declare function upsertOpenRouterBrokerCatalog(agentDir: string, agentId: string, input: OpenRouterBrokerCatalogInput): PlatformBrokerCatalogResult;
export declare function upsertOpenAiBrokerCatalog(agentDir: string, agentId: string, input: OpenRouterBrokerCatalogInput): PlatformBrokerCatalogResult;
export declare function removeOpenRouterBrokerModel(agentDir: string): boolean;
/**
 * Boot/reconcile materialization: ensure every shared customer-agent has its
 * anthropic:default broker-token profile. Idempotent + tolerant — a failure on
 * one agent (corrupt store, missing dir) never aborts the sweep. Returns the
 * count actually written. `agentsDir` is injectable for tests.
 */
export declare function materializeAnthropicBrokerForAgents(agentIds: string[], opts?: {
    agentsDir?: string;
    logFn?: (m: string) => void;
}): number;
/** Agents whose catalogs landed but whose store-backed profiles still need a
 *  retry once openclaw is up. `materialized` counts agents with any write. */
export interface BrokerProfileSweepResult {
    materialized: number;
    deferred: string[];
}
export declare function materializeBrokerProfilesForAgents(agentIds: string[], opts?: {
    agentsDir?: string;
    openRouter?: OpenRouterBrokerCatalogInput;
    openAi?: OpenRouterBrokerCatalogInput;
    logFn?: (m: string) => void;
}): BrokerProfileSweepResult;
