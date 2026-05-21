// Dual-mount URL-prefix stripping for chat-proxy fleet routing.
//
// `chat-proxy-fleet-ingress` (chat.octogee.com) routes
// `/g/<gatewayId>/*` to the per-instance `chat-proxy-<instanceName>`
// Service. Once the request arrives at this chat-proxy, the
// `/g/<gatewayId>` segment is purely a routing artifact — downstream
// route matchers (`/api/openclaw/ws/<uuid>`, `/api/mattermost/...`,
// `/api/v4/...`, etc.) don't know about it. Strip it here so every
// matcher works unchanged on both `/api/<p>` AND `/g/<gw>/api/<p>`.
//
// Mirror of the workspace-api dual-mount helper landed earlier today
// (FLEET-API-ROUTING-SPEC.md task #14).
//
// Implementation note: split-based (no nested-quantifier regex) to
// avoid ReDoS on adversarial inputs like `/g/aaaa.../`. gatewayId is
// validated against the same pattern as `resolveBridgeGatewayId` to
// keep the seam consistent across the codebase.

const GATEWAY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function stripGatewayPrefix(urlPath: string): string {
  if (!urlPath.startsWith("/g/")) return urlPath;
  const rest = urlPath.slice(3); // after "/g/"
  const slashIdx = rest.indexOf("/");
  const gwId = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  // Validate against the canonical gatewayId pattern. Malformed prefixes
  // are NOT stripped — they fall through to the original urlPath so
  // downstream 404 handlers see the same input a non-fleet request would.
  if (!GATEWAY_ID_PATTERN.test(gwId)) return urlPath;
  // `/g/<gw>` with no trailing slash → return `/` so downstream route
  // matchers that assume a leading slash still find the empty path. Same
  // semantics as `/g/<gw>/` → `/`.
  if (slashIdx === -1) return "/";
  return rest.slice(slashIdx);
}

/**
 * In-place mutation: strip the gateway prefix from `req.url` so every
 * downstream consumer (matchers, forwardMmRest, approvalCallbackHandler)
 * sees the post-strip path. Returns the stripped path (without query) so
 * the caller can use it for routing decisions without re-parsing.
 *
 * Idempotent: a second call on the same req is a no-op (the prefix has
 * already been removed). Safe to call from both the HTTP request handler
 * and the WS upgrade handler.
 */
export function applyGatewayPrefixStripInPlace(
  req: { url?: string | undefined | null },
): string {
  const original = req.url || "";
  const qIdx = original.indexOf("?");
  const rawPath = qIdx === -1 ? original : original.slice(0, qIdx);
  const query = qIdx === -1 ? "" : original.slice(qIdx);
  const strippedPath = stripGatewayPrefix(rawPath);
  if (strippedPath !== rawPath) {
    req.url = strippedPath + query;
  }
  return strippedPath;
}
