/**
 * Validate OAuth redirect URLs to prevent open redirect attacks.
 *
 * Only allows relative paths or URLs to known Octogee domains.
 */

const ALLOWED_HOSTS = new Set([
  "octogee.com",
  "www.octogee.com",
  "octogee.web.app",
  "octogee-test.web.app",
  "octogee.firebaseapp.com",
  "octogee-test.firebaseapp.com",
  "localhost",
]);

/**
 * Sanitize a returnUrl from a query parameter.
 * Returns the URL if safe, or the fallback if not.
 */
export function sanitizeReturnUrl(
  returnUrl: string | undefined,
  fallback = "/dashboard",
): string {
  if (!returnUrl || typeof returnUrl !== "string") {
    return fallback;
  }

  const trimmed = returnUrl.trim();

  // Relative paths are always safe
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }

  // Validate absolute URLs
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      ALLOWED_HOSTS.has(parsed.hostname)
    ) {
      return trimmed;
    }
  } catch {
    // Invalid URL — fall through to fallback
  }

  return fallback;
}
