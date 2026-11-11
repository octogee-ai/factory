import { type ModelCatalogEntry } from "./model-catalog.js";
export interface AgentModelSelection {
    primary: string;
    fallbacks: string[];
}
export type AgentModelSelections = Record<string, AgentModelSelection>;
export declare const MAX_AGENT_MODEL_FALLBACKS = 3;
export declare const OPENROUTER_PLATFORM_PROVIDER_ID = "platform-openrouter";
export declare const OPENAI_PLATFORM_PROVIDER_ID = "platform-openai";
export declare const VERTEX_PLATFORM_PROVIDER_ID = "platform-vertex";
export declare function isValidModelRef(value: unknown): value is string;
export declare function modelRefForCatalogEntry(entry: ModelCatalogEntry): string;
export declare function platformModelRefs(): string[];
export declare function catalogEntryForModelRef(ref: string): ModelCatalogEntry | null;
export declare const SIMPLE_MODEL_TIER_IDS: readonly ["errands", "everyday", "hard"];
export type SimpleModelTierId = (typeof SIMPLE_MODEL_TIER_IDS)[number];
export interface SimpleModelTier {
    id: SimpleModelTierId;
    label: string;
    description: string;
    ref: string;
}
export declare const SIMPLE_MODEL_TIERS: Readonly<Record<SimpleModelTierId, SimpleModelTier>>;
export declare function simpleModelTierForRef(ref: string): SimpleModelTier | null;
export declare function parseAgentModelSelection(value: unknown): AgentModelSelection | null;
export declare function parseAgentModelSelections(value: unknown): AgentModelSelections;
export declare function agentIdBelongsToSlug(agentId: string, slug: string): boolean;
export declare function canonicalUserModelDefinition(modelRef: string): Record<string, unknown>;
