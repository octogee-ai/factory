import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import express, { type Request, type Response } from "express";

import {
  NPM_CACHE_CAPABILITY_AUDIENCE,
  type NpmCacheCapabilityAuthorization,
} from "./lib/npm-cache-capabilities.js";

const CAPABILITY_RE = /^[A-Za-z0-9_-]{43,128}$/u;
const MAX_AUTHORIZATIONS_IN_FLIGHT = 128;
const MAX_CACHED_AUTHORIZATIONS = 2_048;
const MAX_REQUESTS_PER_CAPABILITY = 4_096;
const MAX_CONCURRENT_REQUESTS_PER_CAPABILITY = 16;
const MAX_GLOBAL_UPSTREAM_REQUESTS = 128;
const MAX_REQUEST_TARGET_LENGTH = 4_096;

interface CachedAuthorization {
  authorization: NpmCacheCapabilityAuthorization;
  expiresAtMs: number;
  remainingRequests: number;
  activeRequests: number;
  lastUsedAtMs: number;
}

type CapabilityLeaseFailure =
  | "authorization-unavailable"
  | "forbidden"
  | "request-limit"
  | "concurrency-limit";

interface CapabilityLease {
  authorizationCache: "cold" | "warm";
  release(): void;
}

function capabilityDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function bearerToken(req: Request): string | null {
  const header = req.get("authorization");
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/u.exec(header);
  return match?.[1] ?? null;
}

function validAuthorization(
  value: NpmCacheCapabilityAuthorization | null,
  nowMs: number,
): value is NpmCacheCapabilityAuthorization {
  if (!value || value.audience !== NPM_CACHE_CAPABILITY_AUDIENCE) return false;
  const expiresAtMs = Date.parse(value.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs &&
    Number.isInteger(value.maxRequests) && value.maxRequests > 0 &&
    value.maxRequests <= MAX_REQUESTS_PER_CAPABILITY &&
    typeof value.gatewayId === "string" && value.gatewayId.length > 0 &&
    typeof value.uid === "string" && value.uid.length > 0 &&
    typeof value.slug === "string" && value.slug.length > 0 &&
    typeof value.podUid === "string" && value.podUid.length > 0;
}

class CapabilityGate {
  readonly #authorizations = new Map<string, CachedAuthorization>();
  readonly #pending = new Map<string, Promise<NpmCacheCapabilityAuthorization | null>>();
  readonly #authorize: (token: string) => Promise<NpmCacheCapabilityAuthorization | null>;
  readonly #now: () => number;

  constructor(options: {
    authorize: (token: string) => Promise<NpmCacheCapabilityAuthorization | null>;
    now: () => number;
  }) {
    this.#authorize = options.authorize;
    this.#now = options.now;
  }

  #removeExpired(nowMs: number): void {
    for (const [digest, cached] of this.#authorizations) {
      if (cached.expiresAtMs <= nowMs && cached.activeRequests === 0) {
        this.#authorizations.delete(digest);
      }
    }
  }

  #makeRoom(nowMs: number): void {
    this.#removeExpired(nowMs);
    if (this.#authorizations.size < MAX_CACHED_AUTHORIZATIONS) return;
    let oldest: { digest: string; at: number } | null = null;
    for (const [digest, cached] of this.#authorizations) {
      if (cached.activeRequests > 0) continue;
      if (!oldest || cached.lastUsedAtMs < oldest.at) oldest = { digest, at: cached.lastUsedAtMs };
    }
    if (oldest) this.#authorizations.delete(oldest.digest);
  }

  async #resolve(
    token: string,
    digest: string,
    nowMs: number,
  ): Promise<{ record: CachedAuthorization; cache: "cold" | "warm" } | null> {
    const cached = this.#authorizations.get(digest);
    if (cached && cached.expiresAtMs > nowMs) return { record: cached, cache: "warm" };
    if (cached?.activeRequests === 0) this.#authorizations.delete(digest);

    let pending = this.#pending.get(digest);
    if (!pending) {
      if (this.#pending.size >= MAX_AUTHORIZATIONS_IN_FLIGHT) {
        throw new Error("npm cache authorization capacity exhausted");
      }
      pending = this.#authorize(token).finally(() => this.#pending.delete(digest));
      this.#pending.set(digest, pending);
    }
    const authorization = await pending;
    const resolvedAtMs = this.#now();
    if (!validAuthorization(authorization, resolvedAtMs)) return null;
    this.#makeRoom(resolvedAtMs);
    const record: CachedAuthorization = {
      authorization,
      expiresAtMs: Date.parse(authorization.expiresAt),
      remainingRequests: authorization.maxRequests,
      activeRequests: 0,
      lastUsedAtMs: resolvedAtMs,
    };
    this.#authorizations.set(digest, record);
    return { record, cache: "cold" };
  }

  async acquire(token: string): Promise<CapabilityLease | CapabilityLeaseFailure> {
    if (!CAPABILITY_RE.test(token)) return "forbidden";
    const nowMs = this.#now();
    let resolved: { record: CachedAuthorization; cache: "cold" | "warm" } | null;
    try {
      resolved = await this.#resolve(token, capabilityDigest(token), nowMs);
    } catch {
      return "authorization-unavailable";
    }
    if (!resolved) return "forbidden";
    const { record } = resolved;
    if (record.remainingRequests <= 0) return "request-limit";
    if (record.activeRequests >= MAX_CONCURRENT_REQUESTS_PER_CAPABILITY) {
      return "concurrency-limit";
    }
    record.remainingRequests -= 1;
    record.activeRequests += 1;
    record.lastUsedAtMs = this.#now();
    let released = false;
    return {
      authorizationCache: resolved.cache,
      release: () => {
        if (released) return;
        released = true;
        record.activeRequests -= 1;
      },
    };
  }
}

export function safeRegistryTarget(
  rawTarget: string | undefined,
  upstreamRegistryUrl: string,
): URL | null {
  if (!rawTarget || rawTarget.length > MAX_REQUEST_TARGET_LENGTH || rawTarget.startsWith("//")) {
    return null;
  }
  if (rawTarget.includes("\\") || /(?:^|\/)(?:\.|%2e)(?:\.|%2e)?(?:\/|\?|#|$)/iu.test(rawTarget)) {
    return null;
  }
  let requestTarget: URL;
  try {
    requestTarget = new URL(rawTarget, "http://npm-cache-proxy.invalid");
  } catch {
    return null;
  }
  const upstream = new URL(upstreamRegistryUrl);
  if (requestTarget.origin !== "http://npm-cache-proxy.invalid") return null;
  if (requestTarget.username || requestTarget.password || requestTarget.hash) return null;
  const target = new URL(upstream);
  target.pathname = `${upstream.pathname.replace(/\/$/u, "")}${requestTarget.pathname}`;
  target.search = requestTarget.search;
  return target;
}

const FORWARDED_RESPONSE_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-length",
  "content-type",
  "etag",
  "last-modified",
] as const;

function proxyStatusForFailure(failure: CapabilityLeaseFailure): number {
  if (failure === "forbidden") return 403;
  if (failure === "authorization-unavailable") return 503;
  return 429;
}

export interface NpmCacheProxyEvent {
  outcome: "success" | "rejected" | "upstream-error";
  status: number;
  durationMs: number;
  reason?: string;
  authorizationCache?: "cold" | "warm";
  authorizationMs?: number;
  artifactCredentialMs?: number;
  upstreamHeadersMs?: number;
  upstreamAgeSeconds?: number;
}

export function createNpmCacheProxyApp(options: {
  authorizeCapability: (token: string) => Promise<NpmCacheCapabilityAuthorization | null>;
  artifactRegistryAccessToken: () => Promise<string>;
  upstreamRegistryUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  reportEvent?: (event: NpmCacheProxyEvent) => void;
}): express.Express {
  const now = options.now ?? Date.now;
  const upstreamRegistryUrl = new URL(options.upstreamRegistryUrl).toString();
  const gate = new CapabilityGate({ authorize: options.authorizeCapability, now });
  let activeUpstreamRequests = 0;
  const report = options.reportEvent ?? (() => undefined);
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store").status(200).json({ status: "ok" });
  });

  app.use(async (req: Request, res: Response) => {
    const startedAtMs = now();
    const target = req.method === "GET" || req.method === "HEAD"
      ? safeRegistryTarget(req.originalUrl, upstreamRegistryUrl)
      : null;
    if (!target) {
      const status = req.method === "GET" || req.method === "HEAD" ? 404 : 405;
      res.set("Cache-Control", "no-store").status(status).end();
      report({ outcome: "rejected", status, durationMs: now() - startedAtMs, reason: "target" });
      return;
    }
    const token = bearerToken(req);
    if (!token) {
      res.set("Cache-Control", "no-store").status(403).end();
      report({ outcome: "rejected", status: 403, durationMs: now() - startedAtMs, reason: "auth" });
      return;
    }
    const authorizationStartedAtMs = now();
    const lease = await gate.acquire(token);
    const authorizationMs = now() - authorizationStartedAtMs;
    if (typeof lease === "string") {
      const status = proxyStatusForFailure(lease);
      res.set("Cache-Control", "no-store").status(status).end();
      report({
        outcome: "rejected",
        status,
        durationMs: now() - startedAtMs,
        authorizationMs,
        reason: lease,
      });
      return;
    }
    if (activeUpstreamRequests >= MAX_GLOBAL_UPSTREAM_REQUESTS) {
      lease.release();
      res.set("Cache-Control", "no-store").status(429).end();
      report({ outcome: "rejected", status: 429, durationMs: now() - startedAtMs, reason: "capacity" });
      return;
    }

    activeUpstreamRequests += 1;
    try {
      const credentialStartedAtMs = now();
      const accessToken = await options.artifactRegistryAccessToken();
      const artifactCredentialMs = now() - credentialStartedAtMs;
      if (!accessToken) throw new Error("artifact registry access token unavailable");
      const upstreamStartedAtMs = now();
      const upstream = await (options.fetchImpl ?? fetch)(target, {
        method: req.method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: req.get("accept") ?? "application/json",
          "accept-encoding": "identity",
          "user-agent": "octogee-npm-cache-proxy/1",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
      });
      const upstreamHeadersMs = now() - upstreamStartedAtMs;
      res.status(upstream.status);
      for (const header of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(header);
        if (value) res.set(header, value);
      }
      if (req.method === "HEAD" || !upstream.body) {
        res.end();
      } else {
        await pipeline(
          Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>),
          res,
        );
      }
      report({
        outcome: "success",
        status: upstream.status,
        durationMs: now() - startedAtMs,
        authorizationCache: lease.authorizationCache,
        authorizationMs,
        artifactCredentialMs,
        upstreamHeadersMs,
        upstreamAgeSeconds: Number(upstream.headers.get("age")) || undefined,
      });
    } catch (error) {
      if (!res.headersSent) {
        res.set("Cache-Control", "no-store").status(502).json({ error: "npm_cache_upstream_unavailable" });
      } else {
        res.destroy();
      }
      report({
        outcome: "upstream-error",
        status: 502,
        durationMs: now() - startedAtMs,
        authorizationCache: lease.authorizationCache,
        authorizationMs,
        reason: error instanceof Error ? error.name : "Error",
      });
    } finally {
      activeUpstreamRequests -= 1;
      lease.release();
    }
  });

  return app;
}
