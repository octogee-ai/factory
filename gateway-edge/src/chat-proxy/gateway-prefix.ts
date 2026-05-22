// Fleet path-affinity prefix stripping for WS surfaces on gateway-edge.
//
// The api.octogee.com fleet ingress routes `/api/g/<gatewayId>/*` to the
// per-instance gateway-edge Service so the request lands on the user's
// home pod. Once here, the `/api/g/<gatewayId>` segment is a routing
// artifact — the chat-proxy WS matchers (`/api/openclaw/ws/<uuid>`,
// `/api/v4/websocket`, builder-shell) don't know about it. Strip it so
// every matcher works on both `/api/<p>` AND `/api/g/<gw>/api/<p>`.
//
// Unified onto `/api/g/<gw>/` (POST-BENDER-CLEANUP-SPEC §2.7): the old
// chat-only `/g/<gw>/` scheme is retired now that chat shares the
// gateway-edge fleet seam used by workspace/git.
//
// Split-based (no nested-quantifier regex) to avoid ReDoS. gatewayId is
// validated against the canonical pattern.

const GATEWAY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FLEET_PREFIX = "/api/g/";

export function stripGatewayPrefix(urlPath: string): string {
  if (!urlPath.startsWith(FLEET_PREFIX)) return urlPath;
  const rest = urlPath.slice(FLEET_PREFIX.length); // after "/api/g/"
  const slashIdx = rest.indexOf("/");
  const gwId = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  // Malformed prefixes are NOT stripped — they fall through to the
  // original urlPath so downstream 404 handlers see the same input a
  // non-fleet request would.
  if (!GATEWAY_ID_PATTERN.test(gwId)) return urlPath;
  // `/api/g/<gw>` with no trailing path → `/` so matchers that assume a
  // leading slash still resolve the empty path.
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
