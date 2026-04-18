/**
 * Global error handler — replaces per-handler try/catch → res.status(500).
 *
 * Routes can throw or call next(err) and this catches everything.
 * Known error messages map to specific HTTP status codes.
 */
import { Request, Response, NextFunction } from "express";
import { logger } from "./logging";

const STATUS_MAP: Record<string, number> = {
  Unauthenticated: 401,
  "Invalid token": 401,
  "User not found": 404,
  Forbidden: 403,
  "Access denied": 403,
  "Admin access required": 403,
};

class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // ApiError has an explicit status code
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // Map known error messages to status codes
  const status = STATUS_MAP[err.message] || 500;

  if (status >= 500) {
    logger.error(`Unhandled error: ${err.message}`, {
      path: req.path,
      method: req.method,
      stack: err.stack?.slice(0, 500),
    });
  }

  res.status(status).json({ error: err.message || "Internal server error" });
}
