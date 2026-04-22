/**
 * HMAC-SHA256 request signing for the fleet controller → gateway channel.
 *
 * Controller signs `${jobId}\n${rawBody}` with a shared secret and puts the
 * hex digest in the `X-Fleet-Controller-Signature` header. Gateway verifies
 * on receipt. The shared secret lives in both the controller's SA config
 * and the gateway's `FLEET_CONTROLLER_SECRET` env var; rotation is
 * atomic-swap of both.
 *
 * Chose HMAC over OIDC because the gateway endpoint doesn't sit behind
 * Cloud Run / IAP — it's a plain HTTP service in-cluster, reachable from
 * Cloud Tasks through whatever routing Phase 3 settles on. HMAC works
 * independent of the transport auth story.
 *
 * Pure module: no I/O, no crypto state. Tests import and call directly.
 */

import { createHmac, timingSafeEqual } from "crypto";

/** Canonical payload the sender must sign and the receiver must verify. */
export function canonicalPayload(jobId: string, rawBody: string): string {
  return `${jobId}\n${rawBody}`;
}

/** Hex-encoded HMAC-SHA256. Safe to log; reveals nothing about the secret. */
export function signFleetRequest(
  secret: string,
  jobId: string,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(canonicalPayload(jobId, rawBody))
    .digest("hex");
}

/**
 * Constant-time verification. Mismatched-length sigs return false without
 * advancing through the comparison — guards against a slightly wider
 * timing oracle than timingSafeEqual would throw on. No-throw semantics
 * so callers can log a single "bad signature" line rather than catching.
 */
export function verifyFleetRequest(
  secret: string,
  jobId: string,
  rawBody: string,
  headerValue: string | undefined,
): boolean {
  if (!headerValue) return false;
  const expected = signFleetRequest(secret, jobId, rawBody);
  if (expected.length !== headerValue.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(headerValue, "utf8"),
    );
  } catch {
    return false;
  }
}
