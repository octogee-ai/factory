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

function requireValidGatewayId(gatewayId: string): void {
  if (!GATEWAY_ID_PATTERN.test(gatewayId)) {
    throw new GatewayTokenError(
      "invalid-gateway-id",
      `gatewayId ${JSON.stringify(gatewayId)} does not match ${GATEWAY_ID_PATTERN}`,
    );
  }
}

function projectIdFromEnv(projectId?: string): string {
  return projectId ?? process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
}

function envTokenFallback(opts: {
  gatewayId: string;
  projectId: string;
}): string | null {
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  const isLocalOperatorGateway =
    process.env.GATEWAY_PROFILE === "operator" &&
    process.env.GATEWAY_ID === opts.gatewayId;
  if (isLocalOperatorGateway && envToken.length > 0) return envToken;
  if (opts.projectId) return null;
  if (envToken.length > 0) return envToken;
  throw new GatewayTokenError(
    "not-configured",
    "GCP_PROJECT_ID unset and OPENCLAW_GATEWAY_TOKEN unset — no token source",
  );
}

function cachedToken(gatewayId: string, skipCache?: boolean): string | null {
  if (skipCache) return null;
  const cached = cache.get(gatewayId);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_CACHE_TTL_MS) {
    return cached.token;
  }
  return null;
}

function isSecretManagerNetworkDown(e: { code?: unknown; errno?: unknown }): boolean {
  return (
    e.code === 14 ||
    e.errno === "ENOTFOUND" ||
    e.errno === "ECONNREFUSED" ||
    (typeof e.code === "string" && (e.code === "ENOTFOUND" || e.code === "ECONNREFUSED"))
  );
}

function assertResolvedToken(token: string, secretName: string, gatewayId: string): void {
  if (!token || token.trim().length === 0) {
    throw new GatewayTokenError(
      "empty-token",
      `Secret ${secretName} returned an empty payload — gateway publish failed?`,
    );
  }
  // eslint-disable-next-line security/detect-possible-timing-attacks -- public bootstrap sentinel, not a secret-dependent auth decision.
  if (token === GATEWAY_TOKEN_PLACEHOLDER) {
    throw new GatewayTokenError(
      "empty-token",
      `gateway-auth-token-${gatewayId} is still the bootstrap placeholder — gateway has not yet published its token`,
    );
  }
}

function rememberToken(gatewayId: string, token: string): void {
  if (cache.size >= TOKEN_CACHE_MAX_ENTRIES && !cache.has(gatewayId)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(gatewayId, { token, fetchedAt: Date.now() });
}

export async function fetchGatewayToken(
  opts: FetchGatewayTokenOptions,
): Promise<string> {
  requireValidGatewayId(opts.gatewayId);
  const projectId = projectIdFromEnv(opts.projectId);
  const fallback = envTokenFallback({ gatewayId: opts.gatewayId, projectId });
  if (fallback) return fallback;
  const cached = cachedToken(opts.gatewayId, opts.skipCache);
  if (cached) return cached;

  const client = opts.client ?? getClient();
  const secretName = `projects/${projectId}/secrets/gateway-auth-token-${opts.gatewayId}/versions/latest`;

  let accessResult;
  try {
    [accessResult] = await client.accessSecretVersion({ name: secretName });
  } catch (err) {
    const e = err as { code?: unknown; errno?: unknown } & Error;
    const envToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
    if (envToken.length > 0 && isSecretManagerNetworkDown(e)) {
      return envToken;
    }
    throw new GatewayTokenError(
      "fetch-failed",
      `Secret Manager access failed for ${secretName}: ${e.message}`,
    );
  }

  const payload = accessResult.payload?.data;
  const token = typeof payload === "string" ? payload : Buffer.from(payload ?? "").toString("utf8");
  assertResolvedToken(token, secretName, opts.gatewayId);
  rememberToken(opts.gatewayId, token);
  return token;
}

export function invalidateGatewayToken(gatewayId: string): void {
  cache.delete(gatewayId);
}

export function __resetGatewayTokenCacheForTest(): void {
  cache.clear();
}
