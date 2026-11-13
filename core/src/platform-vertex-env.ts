export function configuredPlatformVertexBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PLATFORM_VERTEX_BASE_URL?.trim();
  return raw || null;
}
