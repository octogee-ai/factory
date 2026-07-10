import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";

export const TENANT_BINDING_AUDIENCE = "octogee-api";
export const DEFAULT_K8S_SA_TOKEN_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/token";
export const DEFAULT_K8S_CA_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

export type ReviewResult =
  | { authenticated: false }
  | {
      authenticated: true;
      saName: string;
      namespace: string;
      audiences: string[];
      podName?: string;
      podUid?: string;
    };

export type Reviewer = (jwt: string) => Promise<ReviewResult>;

export interface TokenReviewHttpRequest {
  url: string;
  bearerToken: string;
  body: Record<string, unknown>;
  ca?: string;
}

export interface TokenReviewHttpResponse {
  status: number;
  body: unknown;
}

export type TokenReviewTransport = (
  req: TokenReviewHttpRequest,
) => Promise<TokenReviewHttpResponse>;

interface CacheEntry {
  tokenHash: string;
  result: Extract<ReviewResult, { authenticated: true }>;
  at: number;
}

export interface KubernetesTokenReviewerOptions {
  transport?: TokenReviewTransport;
  now?: () => number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  apiHost?: string;
  apiPort?: string;
  reviewerTokenPath?: string;
  caPath?: string;
}

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_CACHE_MAX_ENTRIES = 1_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseUsername(username: unknown): { namespace: string; saName: string } | null {
  if (typeof username !== "string") return null;
  const parts = username.split(":");
  if (parts.length !== 4) return null;
  const [system, kind, namespace, saName] = parts;
  if (system !== "system" || kind !== "serviceaccount") return null;
  if (!namespace || !saName) return null;
  return { namespace, saName };
}

function parseAudiences(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function tokenReviewExtraString(extra: unknown, key: string): string | null {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return null;
  const values = (extra as Record<string, unknown>)[key];
  if (!Array.isArray(values) || values.length !== 1) return null;
  const value = values[0];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseTokenReview(body: unknown): ReviewResult {
  const status = body && typeof body === "object"
    ? (body as { status?: Record<string, unknown> }).status
    : undefined;
  if (!status || status.authenticated !== true) {
    return { authenticated: false };
  }

  const audiences = parseAudiences(status.audiences);
  if (!audiences.includes(TENANT_BINDING_AUDIENCE)) {
    return { authenticated: false };
  }

  const parsed = parseUsername(
    (status.user as { username?: unknown } | undefined)?.username,
  );
  if (!parsed) return { authenticated: false };
  const extra = (status.user as { extra?: unknown } | undefined)?.extra;
  const podName = tokenReviewExtraString(
    extra,
    "authentication.kubernetes.io/pod-name",
  );
  const podUid = tokenReviewExtraString(
    extra,
    "authentication.kubernetes.io/pod-uid",
  );
  return {
    authenticated: true,
    namespace: parsed.namespace,
    saName: parsed.saName,
    audiences,
    ...(podName && podUid ? { podName, podUid } : {}),
  };
}

function evictOldest(cache: Map<string, CacheEntry>): void {
  const oldest = cache.keys().next().value as string | undefined;
  if (oldest) cache.delete(oldest);
}

async function defaultTransport(
  req: TokenReviewHttpRequest,
): Promise<TokenReviewHttpResponse> {
  const body = JSON.stringify(req.body);
  const url = new URL(req.url);

  return new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = {
      authorization: `Bearer ${req.bearerToken}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body).toString(),
    };
    const httpReq = httpsRequest(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        ca: req.ca,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = {};
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = { raw: text };
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    httpReq.on("error", reject);
    httpReq.end(body);
  });
}

export function createKubernetesTokenReviewer(
  opts: KubernetesTokenReviewerOptions = {},
): Reviewer {
  const transport = opts.transport ?? defaultTransport;
  const now = opts.now ?? Date.now;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cacheMaxEntries = opts.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  const cache = new Map<string, CacheEntry>();

  return async (jwt: string): Promise<ReviewResult> => {
    const tokenHash = sha256(jwt);
    const cached = cache.get(tokenHash);
    if (cached && now() - cached.at < cacheTtlMs) {
      return cached.result;
    }
    cache.delete(tokenHash);

    const apiHost =
      opts.apiHost ?? process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc";
    const apiPort = opts.apiPort ?? process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443";
    const reviewerTokenPath = opts.reviewerTokenPath ?? DEFAULT_K8S_SA_TOKEN_PATH;
    const caPath = opts.caPath ?? DEFAULT_K8S_CA_PATH;
    const bearerToken = (await readFile(reviewerTokenPath, "utf8")).trim();
    const ca = await readFile(caPath, "utf8").catch(() => undefined);
    const response = await transport({
      url: `https://${apiHost}:${apiPort}/apis/authentication.k8s.io/v1/tokenreviews`,
      bearerToken,
      ca,
      body: {
        apiVersion: "authentication.k8s.io/v1",
        kind: "TokenReview",
        spec: { token: jwt, audiences: [TENANT_BINDING_AUDIENCE] },
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`TokenReview HTTP ${response.status}`);
    }

    const result = parseTokenReview(response.body);
    if (result.authenticated) {
      if (cache.size >= cacheMaxEntries && !cache.has(tokenHash)) {
        evictOldest(cache);
      }
      cache.set(tokenHash, { tokenHash, result, at: now() });
    } else {
      cache.delete(tokenHash);
    }
    return result;
  };
}
