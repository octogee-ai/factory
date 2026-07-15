import { type ModelCatalogEntry } from "./model-catalog.js";
export interface AgentModelSelection {
    primary: string;
    fallbacks: string[];
}
export type AgentModelSelections = Record<string, AgentModelSelection>;
export declare const MAX_AGENT_MODEL_FALLBACKS = 3;
export declare const OPENROUTER_PLATFORM_PROVIDER_ID = "platform-openrouter";
export declare const OPENAI_PLATFORM_PROVIDER_ID = "platform-openai";
export declare function isValidModelRef(value: unknown): value is string;
export declare function modelRefForCatalogEntry(entry: ModelCatalogEntry): string;
export declare function platformModelRefs(): string[];
export declare function catalogEntryForModelRef(ref: string): ModelCatalogEntry | null;
export declare function parseAgentModelSelection(value: unknown): AgentModelSelection | null;
export declare function parseAgentModelSelections(value: unknown): AgentModelSelections;
export declare function agentIdBelongsToSlug(agentId: string, slug: string): boolean;
