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

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(JSON.stringify({ severity: "INFO", message: msg, ...meta })),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ severity: "WARNING", message: msg, ...meta })),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(JSON.stringify({ severity: "ERROR", message: msg, ...meta })),
  debug: (msg: string, meta?: Record<string, unknown>) => {
    if (logLevel() === "debug") {
      console.log(JSON.stringify({ severity: "DEBUG", message: msg, ...meta }));
    }
  },
};

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    const level =
      res.statusCode >= 500
        ? "error"
        : res.statusCode >= 400
          ? "warn"
          : PROBE_PATHS.has(req.path)
            ? "debug"
            : "info";
    logger[level](`${req.method} ${req.path} ${res.statusCode} ${duration}ms`, {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: duration,
    });
  });
  next();
}
