export const PLATFORM_EMBEDDING_SECRET_PREFIX = "agent-embedding-token-openai-";
const OPENCLAW_REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function recordOrEmpty(value) {
    return isRecord(value) ? value : {};
}
function memorySearchFor(entry) {
    if (isRecord(entry.memorySearch))
        return entry.memorySearch;
    if (isRecord(entry.memory) && isRecord(entry.memory.search))
        return entry.memory.search;
    return undefined;
}
export function platformOpenAiEmbeddingSecretId(agentId) {
    return `${PLATFORM_EMBEDDING_SECRET_PREFIX}${agentId}`;
}
function rebindPlatformEmbeddingRef(entry) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0)
        return entry;
    const memorySearch = memorySearchFor(entry);
    if (!memorySearch || !isRecord(memorySearch.remote) || !isRecord(memorySearch.remote.apiKey)) {
        return entry;
    }
    const apiKey = memorySearch.remote.apiKey;
    if (typeof apiKey.id !== "string")
        return entry;
    const platformShaped = apiKey.id.startsWith("platform-openai-embedding-") ||
        apiKey.id.startsWith(PLATFORM_EMBEDDING_SECRET_PREFIX) ||
        (apiKey.id === OPENCLAW_REDACTED_SENTINEL &&
            apiKey.source === "exec" &&
            apiKey.provider === "gcp-secret-manager");
    if (!platformShaped)
        return entry;
    const expectedId = platformOpenAiEmbeddingSecretId(entry.id);
    if (apiKey.id === expectedId)
        return entry;
    const reboundSearch = {
        ...memorySearch,
        remote: { ...memorySearch.remote, apiKey: { ...apiKey, id: expectedId } },
    };
    if (isRecord(entry.memorySearch))
        return { ...entry, memorySearch: reboundSearch };
    return { ...entry, memory: { ...recordOrEmpty(entry.memory), search: reboundSearch } };
}
export function rebindPlatformEmbeddingRefs(agents) {
    return agents.map(rebindPlatformEmbeddingRef);
}
