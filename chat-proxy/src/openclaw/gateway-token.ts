/**
 * Fetch the live OpenClaw gateway auth token from GCP Secret Manager.
 *
 * The gateway publishes a fresh token on every pod boot (see
 * scripts/publish-gateway-token.mjs) into `gateway-auth-token-{gatewayId}`.
 * chat-proxy reads the latest enabled version when it opens an upstream
 * WS on behalf of a user. Short in-process cache to avoid hammering SM —
 * most user activity lands on the same gateway repeatedly, and GCP
 * charges + rate-limits per access.
 *
 * Cache TTL is short (30s) so a gateway pod restart + token rotation
 * recovers within the window without manual intervention. A cache miss
 * on token (e.g. upstream connect fails with `auth-failed`) should call
 * `invalidateGatewayToken()` to force an immediate re-fetch; callers do
 * that from the upstream error handler.
 *
 * Local dev (docker-compose, no GCP project): if `SecretManagerServiceClient`
 * can't reach its metadata server, resolver falls through to the
 * `OPENCLAW_GATEWAY_TOKEN` env var so the flow still works end-to-end.
 */
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import {
  GATEWAY_ID_PATTERN,
  GATEWAY_TOKEN_PLACEHOLDER,
} from "./gateway-token-constants.js";

export type GatewayTokenErrorCode =
  /** Secret is configured but the current version is empty/missing OR
   *  still the bootstrap placeholder (gateway hasn't published yet). */
  | "empty-token"
  /** SM API returned an error we couldn't handle. */
  | "fetch-failed"
  /** Neither SM nor the env-var fallback has a usable value. */
  | "not-configured"
  /** gatewayId failed validation — malformed input from Firestore. */
  | "invalid-gateway-id";

export class GatewayTokenError extends Error {
  override readonly name = "GatewayTokenError";
  constructor(
    readonly code: GatewayTokenErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Short in-process cache for the resolved token. Key: gatewayId.
 *  NB: the cache is per-pod. If chat-proxy ever scales past 1 replica,
 *  each replica caches independently; a gateway rotation that invalidates
 *  one replica's cache does NOT invalidate peers. For v1 (1 replica)
 *  this is fine. Followup would shorten TTL or push rotations via PubSub. */
interface CacheEntry {
  token: string;
  fetchedAt: number;
}
const TOKEN_CACHE_TTL_MS = 30_000;
/** Hard cap on distinct gatewayIds we'll cache — protects against a DoS
 *  vector if some upstream ever produces arbitrary strings into the cache
 *  keyspace. Evicts oldest (insertion-order) when full. */
const TOKEN_CACHE_MAX_ENTRIES = 128;
const cache = new Map<string, CacheEntry>();

export interface FetchGatewayTokenOptions {
  gatewayId: string;
  /** GCP project id. Default: `GCP_PROJECT_ID` or `GOOGLE_CLOUD_PROJECT` env. */
  projectId?: string;
  /** Optional override for tests — inject a fake client. */
  client?: Pick<
    SecretManagerServiceClient,
    "accessSecretVersion"
  >;
  /** Bypass the in-process cache. Used from the upstream auth-failed path. */
  skipCache?: boolean;
}

let sharedClient: SecretManagerServiceClient | null = null;
function getClient(): SecretManagerServiceClient {
  if (sharedClient === null) sharedClient = new SecretManagerServiceClient();
  return sharedClient;
}

export async function fetchGatewayToken(
  opts: FetchGatewayTokenOptions,
): Promise<string> {
  // Validate gatewayId before interpolating into the SM resource name.
  // Firestore is the source — a corrupt / unexpected value (slashes,
  // whitespace, newlines) would produce an invalid resource name and
  // messy log output. Shape matches helm values + entrypoint.sh.
  if (!GATEWAY_ID_PATTERN.test(opts.gatewayId)) {
    throw new GatewayTokenError(
      "invalid-gateway-id",
      `gatewayId ${JSON.stringify(opts.gatewayId)} does not match ${GATEWAY_ID_PATTERN}`,
    );
  }

  const projectId =
    opts.projectId ?? process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";

  // Local dev / docker-compose fallback — if SM isn't wired, honor the
  // env var so single-box developer loops still work end-to-end.
  const envFallback = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  if (!projectId) {
    if (envFallback.length > 0) return envFallback;
    throw new GatewayTokenError(
      "not-configured",
      "GCP_PROJECT_ID unset and OPENCLAW_GATEWAY_TOKEN unset — no token source",
    );
  }

  if (!opts.skipCache) {
    const cached = cache.get(opts.gatewayId);
    if (cached && Date.now() - cached.fetchedAt < TOKEN_CACHE_TTL_MS) {
      return cached.token;
    }
  }

  const client = opts.client ?? getClient();
  const secretName = `projects/${projectId}/secrets/gateway-auth-token-${opts.gatewayId}/versions/latest`;

  let accessResult;
  try {
    [accessResult] = await client.accessSecretVersion({ name: secretName });
  } catch (err) {
    // Local dev fallback only fires on honest network-unreachable errors,
    // NOT on permission-denied / not-found / precondition etc. Checking
    // err.code (numeric gRPC enum — 14 = UNAVAILABLE) and err.errno
    // (Node-level DNS/socket failures) avoids matching human-authored
    // messages like "secret is in state UNAVAILABLE" that could mask a
    // prod misconfiguration.
    const e = err as { code?: unknown; errno?: unknown } & Error;
    const isNetworkDown =
      e.code === 14 /* grpc UNAVAILABLE */ ||
      e.errno === "ENOTFOUND" ||
      e.errno === "ECONNREFUSED" ||
      (typeof e.code === "string" && (e.code === "ENOTFOUND" || e.code === "ECONNREFUSED"));
    if (envFallback.length > 0 && isNetworkDown) {
      return envFallback;
    }
    throw new GatewayTokenError(
      "fetch-failed",
      `Secret Manager access failed for ${secretName}: ${e.message}`,
    );
  }

  const payload = accessResult.payload?.data;
  const token = typeof payload === "string" ? payload : Buffer.from(payload ?? "").toString("utf8");
  if (!token || token.trim().length === 0) {
    throw new GatewayTokenError(
      "empty-token",
      `Secret ${secretName} returned an empty payload — gateway publish failed?`,
    );
  }
  // Bootstrap window: setup-secrets.sh writes the placeholder literal as
  // the first version so the secret shell has something fetchable. A
  // gateway that hasn't published yet leaves this in place. Rejecting it
  // here turns the bootstrap window into a clean 503 ("service not
  // ready") upstream instead of a 502 from a doomed auth-failed dance.
  if (token === GATEWAY_TOKEN_PLACEHOLDER) {
    throw new GatewayTokenError(
      "empty-token",
      `gateway-auth-token-${opts.gatewayId} is still the bootstrap placeholder — gateway has not yet published its token`,
    );
  }

  // Insertion-order eviction when the cache hits its cap. Small fleets
  // never trip this; the guard is for defense against stray keys.
  if (cache.size >= TOKEN_CACHE_MAX_ENTRIES && !cache.has(opts.gatewayId)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(opts.gatewayId, { token, fetchedAt: Date.now() });
  return token;
}

/**
 * Drop the cached token for a gateway. Called from the upstream WS error
 * path when the gateway rejects our token as `auth-failed` — the gateway
 * may have rotated (pod cycled) during our cache TTL window. Forcing a
 * re-fetch picks up the new token within a second.
 */
export function invalidateGatewayToken(gatewayId: string): void {
  cache.delete(gatewayId);
}

/** Test-only: wipe the module-level cache between tests. */
export function __resetGatewayTokenCacheForTest(): void {
  cache.clear();
}
