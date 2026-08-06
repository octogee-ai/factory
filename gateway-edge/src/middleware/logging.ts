import { Request, Response, NextFunction } from "express";

// Mirrors scripts/lib/config.ts's logLevel() so the same LOG_LEVEL
// env knob steers verbosity across every process in the gateway pod.
// Each package keeps its own logger (different output shape) but
// agrees on this one env contract.
function logLevel(): string {
  return (process.env.LOG_LEVEL ?? "info").toLowerCase();
}

// Kubelet liveness/readiness probes hit these every few seconds —
// success is pure noise, but a failure still wants to surface.
// requestLogger routes probe-path 2xx/3xx through `debug` and lets
// 4xx/5xx fall back to warn/error. Keep in sync with the actual
// routes registered in src/index.ts (`/health`, `/api/health`) and
// any future probe paths the chart's livenessProbe / readinessProbe
// in helm/octogee-gateway/templates/deployment.yaml points at.
const PROBE_PATHS = new Set([
  "/health",
  "/healthz",
  "/ready",
  "/readyz",
  "/api/health",
]);

export function redactRequestPath(path: string): string {
  return path.replace(
    /((?:\/api)?\/g\/[^/]+\/openclaw\/launch\/)[^/?#]+/gu,
    "$1<redacted>",
  );
}

// Without this replacer, JSON.stringify on Error returns {} (name/message/stack
// are non-enumerable) and "no silent failures" silently breaks for every caught
// error logged via { err }.
function serializeMeta(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const k of Object.keys(value)) {
      out[k] = (value as unknown as Record<string, unknown>)[k];
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
  res.on("finish", () => {
    const duration = Date.now() - start;
    const path = redactRequestPath(req.path);
    let level: "error" | "warn" | "debug" | "info";
    if (res.statusCode >= 500) level = "error";
    else if (res.statusCode >= 400) level = "warn";
    else if (PROBE_PATHS.has(req.path)) level = "debug";
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
