import helmet from "helmet";
import rateLimit, { Options as RateLimitOptions } from "express-rate-limit";
import { Request } from "express";

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

export const globalRateLimit = rateLimit({
  ...DEFAULT_RATE_LIMIT_OPTIONS,
  windowMs: 60 * 1000,
  limit: 300,
  message: { error: "Too many requests, please try again later." },
  skip: (req: Request) => {
    return req.path === "/health" || req.path === "/api/health" || req.path === "/metrics";
  },
});

export const strictRateLimit = rateLimit({
  ...DEFAULT_RATE_LIMIT_OPTIONS,
  windowMs: 60 * 1000,
  limit: 30,
  message: { error: "Too many requests, please try again later." },
});

