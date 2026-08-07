import { type ApplyOpenClawSecretsPlanOptions, type AuthProfileApiKeyTarget } from "./openclaw-secrets-apply.js";
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
/** Which broker provider surfaces this pod carries. A profile whose provider is
 *  unconfigured is pure risk: openclaw's exec resolver is batch-fatal, so one
 *  unresolvable ref colds every other owner on the provider. */
export interface PlatformBrokerProfileSurfaces {
    openRouter: boolean;
    openAi: boolean;
}
export declare function platformBrokerProfileTargets(agentId: string, surfaces: PlatformBrokerProfileSurfaces): AuthProfileApiKeyTarget[];
/** The store is read-only to us — openclaw's `secrets apply` is the only writer.
 *  Reading it keeps the sweep from spawning the CLI once everything has settled. */
export declare function missingPlatformBrokerProfileTargets(agentDir: string, agentId: string, surfaces: PlatformBrokerProfileSurfaces): AuthProfileApiKeyTarget[];
export declare function upsertOpenRouterBrokerModel(agentDir: string, input: OpenRouterBrokerModelInput): boolean;
export declare function upsertOpenRouterBrokerCatalog(agentDir: string, input: OpenRouterBrokerCatalogInput): boolean;
export declare function upsertOpenAiBrokerCatalog(agentDir: string, input: OpenRouterBrokerCatalogInput): boolean;
export declare function removeOpenRouterBrokerModel(agentDir: string): boolean;
/** Agents whose catalogs landed but whose profiles openclaw has not accepted
 *  yet. `materialized` counts agents with any write. The reason travels with the
 *  result rather than being logged per agent: this sweep is level-triggered, and
 *  a line printed here would reprint on every tick forever. */
export interface BrokerProfileSweepResult {
    materialized: number;
    deferred: string[];
    deferralReason?: string;
}
export interface BrokerProfileSweepOptions {
    agentsDir?: string;
    openRouter?: OpenRouterBrokerCatalogInput;
    openAi?: OpenRouterBrokerCatalogInput;
    logFn?: (m: string) => void;
    /** Child-process seam for `openclaw secrets apply`. */
    secretsApply?: ApplyOpenClawSecretsPlanOptions;
}
/**
 * Model-ready sweep: assert every broker provider surface per agent — the
 * platform auth profiles AND the OpenRouter/OpenAI catalogs (when the broker's
 * base URLs are configured). After this, switching any agent to any catalog
 * model is a pure roster flip. Tolerant — a failure on one agent never aborts
 * the sweep.
 */
export declare function materializeBrokerProfilesForAgents(agentIds: string[], opts?: BrokerProfileSweepOptions): BrokerProfileSweepResult;
