export declare const MODEL_CATALOG_PROVIDERS: readonly ["anthropic", "openrouter", "openai"];
export type ModelCatalogProvider = (typeof MODEL_CATALOG_PROVIDERS)[number];
export declare const MODEL_REASONING_EFFORTS: readonly ["high", "xhigh"];
export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];
export type ModelCatalogSource = "openclaw-release" | "openrouter" | "openai";
export interface ModelCatalogEntry {
    provider: ModelCatalogProvider;
    id: string;
    label: string;
    source: ModelCatalogSource;
    aliases?: readonly string[];
    contextTokens?: number;
    reasoningEfforts: readonly ModelReasoningEffort[];
    defaultReasoningEffort?: ModelReasoningEffort;
}
export declare const MODEL_CATALOG: readonly ModelCatalogEntry[];
export declare function isModelCatalogProvider(value: unknown): value is ModelCatalogProvider;
export declare function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort;
export declare function modelCatalogForProvider(provider: ModelCatalogProvider): readonly ModelCatalogEntry[];
export declare function modelCatalogEntryFor(provider: ModelCatalogProvider, model: string): ModelCatalogEntry | null;
