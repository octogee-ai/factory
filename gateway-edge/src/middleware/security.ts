import { timingSafeEqual } from "crypto";
import helmet from "helmet";
import rateLimit, { Options as RateLimitOptions } from "express-rate-limit";
import { Request } from "express";

const K8S_SA_TOKEN_HEADER = "x-k8s-sa-token";
const INTERNAL_SERVICE_KEY_HEADER = "x-internal-service-key";

export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'none'"],
      baseUri: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
});

const DEFAULT_RATE_LIMIT_OPTIONS: Partial<RateLimitOptions> = {
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipFailedRequests: false,
};

function isHealthOrMetricsPath(path: string): boolean {
  return path === "/health" || path === "/api/health" || path === "/metrics";
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, "utf8");
  const bBuffer = Buffer.from(b, "utf8");
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

function hasMatchingInternalServiceKey(req: Request): boolean {
  const configured = process.env.INTERNAL_SERVICE_KEY;
  const provided = req.get(INTERNAL_SERVICE_KEY_HEADER);
  return Boolean(configured && provided && timingSafeStringEqual(provided, configured));
}

const SA_JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SA_JWT_MIN_LENGTH = 40;
const SA_JWT_MAX_LENGTH = 8192;

// Structural shape gate only — NOT authentication. A syntactically valid
// base64url JWT still passes here and reaches the Kubernetes TokenReview (on the
// bounded internalRateLimit lane), where it is actually verified and rejected.
// The gate's job is to drop obvious garbage cheaply and cap the crafted-token
// case at internalRateLimit (1200/min) instead of the pre-fix unbounded flood —
// it does not, and is not meant to, stop a well-formed forged token pre-review.
export function isWellFormedServiceAccountJwt(token: string): boolean {
  if (token.length < SA_JWT_MIN_LENGTH || token.length > SA_JWT_MAX_LENGTH) return false;
  const segments = token.split(".");
  return segments.length === 3 && segments.every((segment) => SA_JWT_SEGMENT.test(segment));
}

function isInternalPath(path: string): boolean {
  return path === "/internal" || path.startsWith("/internal/");
}

function carriesWellFormedSaToken(req: Request): boolean {
  const token = req.get(K8S_SA_TOKEN_HEADER);
  return Boolean(token && isWellFormedServiceAccountJwt(token));
}

export const globalRateLimit = rateLimit({
  ...DEFAULT_RATE_LIMIT_OPTIONS,
  windowMs: 60 * 1000,
  limit: 300,
  message: { error: "Too many requests, please try again later." },
  skip: (req: Request) => {
    if (isHealthOrMetricsPath(req.path)) return true;
    if (!isInternalPath(req.path)) return false;
    return hasMatchingInternalServiceKey(req) || carriesWellFormedSaToken(req);
  },
});

// Bounded lane for token-bearing /internal traffic: tenant binding verifies
// the token via a Kubernetes TokenReview, so the exemption from the global
// bucket must not become an unmetered path to that call. Sized for one
// pod's migration/boot burst (the reason internal traffic left the global
// bucket in #2153), not for a flood.
export const internalRateLimit = rateLimit({
  ...DEFAULT_RATE_LIMIT_OPTIONS,
  windowMs: 60 * 1000,
  limit: 1200,
  message: { error: "Too many requests, please try again later." },
  skip: (req: Request) =>
    !isInternalPath(req.path) ||
    hasMatchingInternalServiceKey(req) ||
    !carriesWellFormedSaToken(req),
});

// Shared-state foot-gun: this is ONE instance — every route that uses
// it shares the same 30/min/IP counter. If you need per-route limits,
// call `rateLimit({ ...DEFAULT_RATE_LIMIT_OPTIONS, ... })` inline at
// the route. Don't sprinkle `strictRateLimit` across 5 endpoints and
// expect 5 × 30 — you'll get 30 total and tests will flake.
export const strictRateLimit = rateLimit({
  ...DEFAULT_RATE_LIMIT_OPTIONS,
  windowMs: 60 * 1000,
  limit: 30,
  message: { error: "Too many requests, please try again later." },
});
