const ALLOWED_HOSTS = new Set([
  "octogee.com",
  "www.octogee.com",
  "octogee.web.app",
  "octogee-test.web.app",
  "octogee.firebaseapp.com",
  "octogee-test.firebaseapp.com",
  "localhost",
]);

export function sanitizeReturnUrl(
  returnUrl: string | undefined,
  fallback = "/dashboard",
): string {
  if (!returnUrl || typeof returnUrl !== "string") {
    return fallback;
  }

  const trimmed = returnUrl.trim();

  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      ALLOWED_HOSTS.has(parsed.hostname)
    ) {
      return trimmed;
    }
  } catch {
    // ignore
  }

  return fallback;
}

export function buildOAuthRedirect(
  returnUrl: string | undefined,
  base: string,
  extraParams: Record<string, string>,
): string {
  const sanitized = sanitizeReturnUrl(returnUrl);
  let absolute: string;
  try {
    absolute = sanitized.startsWith("/") ? `${base}${sanitized}` : new URL(sanitized).toString();
  } catch {
    absolute = `${base}/dashboard`;
  }
  const qs = Object.entries(extraParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  if (!qs) return absolute;
  const hashIndex = absolute.indexOf("#");
  const head = hashIndex === -1 ? absolute : absolute.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : absolute.slice(hashIndex);
  return `${head}${head.includes("?") ? "&" : "?"}${qs}${fragment}`;
}
