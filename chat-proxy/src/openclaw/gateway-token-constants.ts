/**
 * Shared constants for the gateway-auth-token flow. Kept in their own
 * module so both chat-proxy (runtime) and setup-secrets.sh (via a grep-
 * friendly well-known string) agree on the sentinels that flow through
 * the system.
 *
 * If you change these values, also update:
 *   - scripts/setup-secrets.sh  (the placeholder literal written on shell create)
 */

/** Sentinel written as the first version when setup-secrets.sh creates
 *  the `gateway-auth-token-{gatewayId}` secret shell. The gateway
 *  overwrites it on its first successful boot. chat-proxy rejects it
 *  with `empty-token` so the failure mode during the bootstrap window
 *  is a clean 503 ("service not ready") rather than a 502 from an
 *  auth-failed upstream handshake. */
export const GATEWAY_TOKEN_PLACEHOLDER = "placeholder-awaiting-gateway-boot";

/** Gateway-id regex — `[a-z0-9-]` 1..64. Matches the allowed shape in
 *  helm values (`values.{test,prod}.yaml`) and entrypoint.sh's GATEWAY_ID
 *  validation. Applied at fetcher entry so a malformed Firestore value
 *  never flows into an SM resource name. */
export const GATEWAY_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
