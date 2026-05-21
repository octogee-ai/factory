import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import {
  GATEWAY_ID_PATTERN,
  GATEWAY_TOKEN_PLACEHOLDER,
} from "./gateway-token-constants.js";

export type GatewayTokenErrorCode =
  | "empty-token"
  | "fetch-failed"
  | "not-configured"
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

interface CacheEntry {
  token: string;
  fetchedAt: number;
}
const TOKEN_CACHE_TTL_MS = 30_000;
const TOKEN_CACHE_MAX_ENTRIES = 128;
const cache = new Map<string, CacheEntry>();

export interface FetchGatewayTokenOptions {
  gatewayId: string;
  projectId?: string;
  client?: Pick<
    SecretManagerServiceClient,
    "accessSecretVersion"
  >;
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
  if (!GATEWAY_ID_PATTERN.test(opts.gatewayId)) {
    throw new GatewayTokenError(
      "invalid-gateway-id",
      `gatewayId ${JSON.stringify(opts.gatewayId)} does not match ${GATEWAY_ID_PATTERN}`,
    );
  }

  const projectId =
    opts.projectId ?? process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";

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
    const e = err as { code?: unknown; errno?: unknown } & Error;
    const isNetworkDown =
      e.code === 14 ||
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
  if (token === GATEWAY_TOKEN_PLACEHOLDER) {
    throw new GatewayTokenError(
      "empty-token",
      `gateway-auth-token-${opts.gatewayId} is still the bootstrap placeholder — gateway has not yet published its token`,
    );
  }

  if (cache.size >= TOKEN_CACHE_MAX_ENTRIES && !cache.has(opts.gatewayId)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(opts.gatewayId, { token, fetchedAt: Date.now() });
  return token;
}

export function invalidateGatewayToken(gatewayId: string): void {
  cache.delete(gatewayId);
}

/** Test-only: wipe the module-level cache between tests. */
export function __resetGatewayTokenCacheForTest(): void {
  cache.clear();
}
