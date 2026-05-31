import { Request, Response, NextFunction } from "express";
import {
  isValidBuilderShellInternalAuth,
  resolveBuilderShellInternalAuthSecret,
} from "../lib/builder-shell-internal-auth.js";
import { logger } from "./logging.js";

function readHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

export function requireBuilderShellInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = resolveBuilderShellInternalAuthSecret(process.env);
  if (!secret) {
    logger.error("builder-shell internal auth is not configured — refusing request");
    res.status(503).json({ error: "Internal auth unavailable" });
    return;
  }

  const provided = readHeader(req, "x-internal-service-key");
  if (!provided) {
    res.status(401).json({ error: "X-Internal-Service-Key header required" });
    return;
  }

  if (!isValidBuilderShellInternalAuth(provided, process.env)) {
    logger.warn(
      `Builder-shell internal auth rejected from ${req.ip} — invalid ${secret.mode} key`,
    );
    res.status(401).json({ error: "Invalid internal service key" });
    return;
  }

  next();
}
