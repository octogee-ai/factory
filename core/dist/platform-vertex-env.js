export function configuredPlatformVertexBaseUrl(env = process.env) {
    const raw = env.PLATFORM_VERTEX_BASE_URL?.trim();
    return raw || null;
}
