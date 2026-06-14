import { Request, Response, NextFunction } from "express";
import {
  isValidBuilderShellInternalAuth,
  resolveBuilderShellInternalAuthSecret,
} from "../lib/builder-shell-internal-auth.js";
import type { Reviewer } from "../lib/kubernetes-token-review.js";
import { logger } from "./logging.js";

let tokenReviewerForTests: Reviewer | null = null;

export function _setBuilderShellTokenReviewerForTests(reviewer: Reviewer | null): void {
  tokenReviewerForTests = reviewer;
}

function readHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

async function handleBuilderShellInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const secret = resolveBuilderShellInternalAuthSecret(process.env);
  if (!secret) {
    logger.error("builder-shell internal auth is not configured — refusing request");
    res.status(503).json({ error: "Internal auth unavailable" });
    return;
  }

  const provided = readHeader(req, secret.headerName);
  if (!provided) {
    res.status(401).json({ error: `${secret.headerName} header required` });
    return;
  }

  let valid = false;
  try {
    valid = await isValidBuilderShellInternalAuth(provided, process.env, {
      reviewer: tokenReviewerForTests ?? undefined,
    });
  } catch (err) {
    logger.error("builder-shell service-account TokenReview failed — refusing request", {
      err: err instanceof Error ? err.message : String(err),
    });
    res.status(503).json({ error: "Internal auth unavailable" });
    return;
  }

  if (!valid) {
    logger.warn(
      `Builder-shell internal auth rejected from ${req.ip} — invalid ${secret.mode} credential`,
    );
    res.status(401).json({ error: "Invalid internal service key" });
    return;
  }

  next();
}

export function requireBuilderShellInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  handleBuilderShellInternalAuth(req, res, next).catch(next);
}
