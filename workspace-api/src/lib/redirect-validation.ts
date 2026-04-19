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

/**
 * Resolve a user-supplied `returnUrl` into a full absolute URL anchored to
 * a trusted base, with an extra trailing query string appended. The output
 * is guaranteed to start with one of the allowlisted hosts or the `base`
 * argument — there's no code path where attacker input flows unchecked into
 * the returned string.
 *
 * Intended for OAuth callback redirects. The two-step
 * `sanitizeReturnUrl(returnUrl).startsWith("http") ? ... : ${BASE}${...}`
 * pattern at the call sites was CodeQL-opaque (it couldn't see through the
 * allowlist function); collapsing the whole thing into one builder makes
 * the source→sink path explicit.
 */
export function buildOAuthRedirect(
  returnUrl: string | undefined,
  base: string,
  extraParams: Record<string, string>,
): string {
  const sanitized = sanitizeReturnUrl(returnUrl);
  // After sanitizeReturnUrl, `sanitized` is either:
  //   a) a relative path beginning with `/` (single `/`, not `//`) — combine with `base`
  //   b) an absolute URL on an allowlisted host
  //   c) the fallback `/dashboard` (relative)
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
  return `${absolute}${absolute.includes("?") ? "&" : "?"}${qs}`;
}
