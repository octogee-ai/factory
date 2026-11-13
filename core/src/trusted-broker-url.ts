function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export function trustedBrokerBaseUrl(
  value: string,
  env: Record<string, string | undefined>,
): string {
  const baseUrl = trimTrailingSlashes(value.trim());
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("automation authorization broker URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("automation authorization broker URL must be an absolute http(s) URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  const namespace = nonBlank(env.K8S_NAMESPACE);
  const namespacedService = namespace &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(namespace) &&
    hostname === `octogee-api.${namespace}.svc.cluster.local`;
  if (
    hostname !== "octogee-api" &&
    !namespacedService &&
    hostname !== "localhost" &&
    hostname !== "127.0.0.1"
  ) {
    throw new Error("automation authorization broker URL must target octogee-api or localhost");
  }
  return baseUrl;
}
