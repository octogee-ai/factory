import { timingSafeEqual } from "crypto";
import helmet from "helmet";
import rateLimit, { Options as RateLimitOptions } from "express-rate-limit";
import { Request, type RequestHandler } from "express";
import { createDashboardAssetRateLimit } from "./dashboard-asset-rate-limit.js";
import { isDashboardAssetRequest } from "./dashboard-asset-request.js";

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

export const DEFAULT_RATE_LIMIT_OPTIONS: Partial<RateLimitOptions> = {
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

const apiRateLimit = rateLimit({
  ...DEFAULT_RATE_LIMIT_OPTIONS,
  windowMs: 60 * 1000,
  limit: 300,
  message: { error: "Too many requests, please try again later." },
  skip: (req: Request) => {
    if (isHealthOrMetricsPath(req.path)) return true;
    if (req.path === "/p" || req.path.startsWith("/p/")) return true;
    if (!isInternalPath(req.path)) return false;
    return hasMatchingInternalServiceKey(req) || carriesWellFormedSaToken(req);
  },
});

const dashboardAssetRateLimit = createDashboardAssetRateLimit();

export const globalRateLimit: RequestHandler = (req, res, next) => {
  if (isDashboardAssetRequest(req)) return dashboardAssetRateLimit(req, res, next);
  return apiRateLimit(req, res, next);
};

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
