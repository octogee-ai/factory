/**
 * Anthropic HTTP status classification helper.
 *
 * Used by provider-probe.ts to map upstream HTTP statuses to either
 * "user" (bad key / wrong account) or "transient" (rate limit / outage).
 */

/**
 * 401/403  → user's fault (key is invalid / wrong account / no permissions).
 * 429      → upstream rate limit. Customer's key is probably fine.
 * 5xx      → upstream outage. Customer's key is probably fine.
 * Other 4xx (400 invalid_request etc.) → user's fault — bad model / bad payload
 *                                         on our side, but symptomatically the
 *                                         client should know.
 */
export function classifyHttp(status: number): "user" | "transient" {
  if (status === 401 || status === 403) return "user";
  if (status === 429) return "transient";
  if (status >= 500) return "transient";
  return "user";
}
