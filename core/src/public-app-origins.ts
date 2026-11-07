export const PUBLIC_APP_ORIGINS_ENV = "PUBLIC_APP_ORIGINS";

export function parsePublicAppOrigins(raw: string | undefined): string[] {
  const entries = (raw ?? "").split(/[\s,]+/u).filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new Error(
      `${PUBLIC_APP_ORIGINS_ENV} must list at least one https origin, separated by commas or whitespace`,
    );
  }
  const origins = new Set<string>();
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`${PUBLIC_APP_ORIGINS_ENV} entry is not a URL: ${JSON.stringify(entry)}`);
    }
    if (url.protocol !== "https:" || url.origin !== entry) {
      throw new Error(`${PUBLIC_APP_ORIGINS_ENV} entry must be a bare https origin: ${JSON.stringify(entry)}`);
    }
    origins.add(url.origin);
  }
  return [...origins];
}

export function publicAppOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return parsePublicAppOrigins(env[PUBLIC_APP_ORIGINS_ENV]);
}

export function publicAppHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return publicAppOriginsFromEnv(env).map((origin) => new URL(origin).hostname);
}
