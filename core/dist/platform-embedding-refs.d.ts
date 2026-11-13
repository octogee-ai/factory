export declare const PLATFORM_EMBEDDING_SECRET_PREFIX = "agent-embedding-token-openai-";
export declare function platformOpenAiEmbeddingSecretId(agentId: string): string;
export declare function rebindPlatformEmbeddingRefs(agents: readonly unknown[]): unknown[];
