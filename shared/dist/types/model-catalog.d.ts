export declare const MODEL_CATALOG_PROVIDERS: readonly ["anthropic", "openrouter", "openai", "vertex"];
export type ModelCatalogProvider = (typeof MODEL_CATALOG_PROVIDERS)[number];
export declare const MODEL_REASONING_EFFORTS: readonly ["high", "xhigh"];
export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];
export type ModelCatalogSource = "openclaw-release" | "openrouter" | "openai" | "vertex";
export declare const MODEL_INPUT_MODALITIES: readonly ["text", "image"];
export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number];
export interface ModelTokenPricing {
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok: number;
    cacheWritePerMTok: number;
}
export interface ModelCatalogEntry {
    provider: ModelCatalogProvider;
    id: string;
    label: string;
    source: ModelCatalogSource;
    aliases?: readonly string[];
    upstreamId?: string;
    contextTokens?: number;
    input?: readonly ModelInputModality[];
    maxOutputTokens?: number;
    reasoning?: boolean;
    pricing?: ModelTokenPricing;
    pricingOverrides?: readonly (Partial<ModelTokenPricing> & {
        aboveInputTokens: number;
    })[];
    reasoningEfforts: readonly ModelReasoningEffort[];
    defaultReasoningEffort?: ModelReasoningEffort;
}
export declare const MODEL_CATALOG: readonly ModelCatalogEntry[];
export declare const VERTEX_MODEL_CATALOG: readonly ModelCatalogEntry[];
export declare function isModelCatalogProvider(value: unknown): value is ModelCatalogProvider;
export declare function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort;
export declare function modelCatalogForProvider(provider: ModelCatalogProvider): readonly ModelCatalogEntry[];
export declare function modelCatalogEntryFor(provider: ModelCatalogProvider, model: string): ModelCatalogEntry | null;
