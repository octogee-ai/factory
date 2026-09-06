import { Request, Response, NextFunction } from "express";
import { redactSecrets, redactStructuredSecrets } from "@octogee/shared/types/secret-redaction";

// Mirrors scripts/lib/config.ts's logLevel() so the same LOG_LEVEL
// env knob steers verbosity across every process in the gateway pod.
// Each package keeps its own logger (different output shape) but
// agrees on this one env contract.
function logLevel(): string {
  return (process.env.LOG_LEVEL ?? "info").toLowerCase();
}

const ROUTINE_PATHS = new Set([
  "/health",
  "/healthz",
  "/ready",
  "/readyz",
  "/api/health",
  "/metrics",
  "/internal/fleet/assignment-roster",
  "/internal/byok/agent-model-token",
  "/internal/openclaw/activity/agent-identity",
]);

export function redactRequestPath(path: string): string {
  return path.replace(
    /((?:\/api)?\/g\/[^/]+\/openclaw\/launch\/)[^/?#]+/gu,
    "$1<redacted>",
  ).replace(/(\/p\/)[0-9a-f]{32}(?=\/|$)/gu, "$1<redacted>");
}

// Without this replacer, JSON.stringify on Error returns {} (name/message/stack
// are non-enumerable) and "no silent failures" silently breaks for every caught
// error logged via { err }.
function serializeMeta(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactSecrets(value.message),
      stack: typeof value.stack === "string" ? redactSecrets(value.stack) : value.stack,
    };
    for (const k of Object.keys(value)) {
      const field = (value as unknown as Record<string, unknown>)[k];
      out[k] = field instanceof Error
        ? field
        : (redactStructuredSecrets({ [k]: field }) as Record<string, unknown>)[k];
    }
    return out;
  }
  return value;
}

function emit(severity: string, msg: string, meta: Record<string, unknown> | undefined): string {
  return JSON.stringify({ severity, message: msg, ...meta }, serializeMeta);
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(emit("INFO", msg, meta)),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(emit("WARNING", msg, meta)),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(emit("ERROR", msg, meta)),
  debug: (msg: string, meta?: Record<string, unknown>) => {
    if (logLevel() === "debug") {
      console.log(emit("DEBUG", msg, meta));
    }
  },
};

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const requestPath = req.path;
  const path = redactRequestPath(requestPath);
  res.on("finish", () => {
    const duration = Date.now() - start;
    let level: "error" | "warn" | "debug" | "info";
    if (res.statusCode >= 500) level = "error";
    else if (res.statusCode >= 400 && ROUTINE_PATHS.has(requestPath)) level = "warn";
    else if (res.statusCode === 404 && req.route === undefined) level = "debug";
    else if (res.statusCode >= 400) level = "warn";
    else if (ROUTINE_PATHS.has(requestPath)) level = "debug";
    else level = "info";
    logger[level](`${req.method} ${path} ${res.statusCode} ${duration}ms`, {
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: duration,
    });
  });
  next();
}
