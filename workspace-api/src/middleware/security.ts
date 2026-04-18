/**
 * Security middleware — Helmet headers + rate limiting scaffolding.
 *
 * Helmet: sets standard HTTP security headers on every response.
 * Rate limiting: global defaults + per-route overrides ready to wire in.
 *
 * Exempt routes (health, metrics, stripe webhook) must stay outside any
 * rate-limiter that would break K8s probes or Stripe retries.
 */
import helmet from "helmet";
import rateLimit, { Options as RateLimitOptions } from "express-rate-limit";
import { Request, Response, NextFunction } from "express";

// ── Helmet security headers ────────────────────────────────────────────────

/**
 * helmetMiddleware — applied globally before any route.
 *
 * Defaults enabled by Helmet 7:
 *  - X-DNS-Prefetch-Control: off
 *  - X-Frame-Options: SAMEORIGIN
 *  - X-Content-Type-Options: nosniff
 *  - Strict-Transport-Security: max-age=15552000 (180 days)
 *  - X-Download-Options: noopen
 *  - X-Permitted-Cross-Domain-Policies: none
 *  - Referrer-Policy: no-referrer
 *  - X-XSS-Protection: 0   (disabled — modern browsers use CSP)
 *  - Cross-Origin-Opener-Policy: same-origin
 *  - Cross-Origin-Resource-Policy: same-origin
 *  - Origin-Agent-Cluster: ?1
 *
 * CSP is disabled here — this is a JSON API, not a browser app.
 * Enable it if we ever serve HTML responses.
 */
export const helmetMiddleware = helmet({
  contentSecurityPolicy: false, // JSON API — no HTML served
  crossOriginEmbedderPolicy: false, // Needed for metrics endpoint compat
});

// ── Rate limiting ──────────────────────────────────────────────────────────

/**
 * Default rate limit options (shared base).
 */
const DEFAULT_RATE_LIMIT_OPTIONS: Partial<RateLimitOptions> = {
  standardHeaders: "draft-7", // Return RateLimit headers per RFC 6585
  legacyHeaders: false, // Disable X-RateLimit-* legacy headers
  skipFailedRequests: false, // Count all requests including failed ones
};

/**
 * Global API rate limit — 300 requests per 1 minute per IP.
 * Conservative for a GKE service behind an LB; tighten per-route as needed.
 *
 * NOTE: For production with multiple replicas, switch from the default
 * in-memory store to a Redis-backed store (e.g. rate-limit-redis).
 * Current in-memory store resets on pod restart and doesn't share across pods.
 */
export const globalRateLimit = rateLimit({
  ...DEFAULT_RATE_LIMIT_OPTIONS,
  windowMs: 60 * 1000, // 1 minute
  limit: 300,
  message: { error: "Too many requests, please try again later." },
  skip: (req: Request) => {
    // Skip rate limiting for health probes and metrics scrapes — these are
    // internal K8s/Prometheus calls, not user traffic.
    return req.path === "/health" || req.path === "/api/health" || req.path === "/metrics";
  },
});

/**
 * Strict rate limit for auth-sensitive / mutation endpoints.
 * 30 requests per minute per IP — tighter budget for expensive operations.
 *
 * Use on: /api/billing, /api/admin, /api/invites
 */
export const strictRateLimit = rateLimit({
  ...DEFAULT_RATE_LIMIT_OPTIONS,
  windowMs: 60 * 1000,
  limit: 30,
  message: { error: "Too many requests, please try again later." },
});

/**
 * Webhook rate limit — permissive, but still bounded.
 * Stripe sends bursts during event replay; 200/min is safe.
 *
 * Use on: /api/billing/webhook
 */
const webhookRateLimit = rateLimit({
  ...DEFAULT_RATE_LIMIT_OPTIONS,
  windowMs: 60 * 1000,
  limit: 200,
  message: { error: "Too many requests, please try again later." },
});

/**
 * No-op placeholder so routes can import a rate limiter that is currently
 * disabled (e.g. during gradual rollout) without changing call sites.
 */
function noopRateLimit(_req: Request, _res: Response, next: NextFunction): void {
  next();
}
