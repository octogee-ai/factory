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

function isInternalServiceRequest(req: Request): boolean {
  if (req.path !== "/internal" && !req.path.startsWith("/internal/")) return false;
  return Boolean(req.get(K8S_SA_TOKEN_HEADER) || hasMatchingInternalServiceKey(req));
}

export const globalRateLimit = rateLimit({
  ...DEFAULT_RATE_LIMIT_OPTIONS,
  windowMs: 60 * 1000,
  limit: 300,
  message: { error: "Too many requests, please try again later." },
  skip: (req: Request) => {
    return isHealthOrMetricsPath(req.path) || isInternalServiceRequest(req);
  },
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
