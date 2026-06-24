import * as crypto from "node:crypto";
import { Request, Response, NextFunction } from "express";
import {
  BYOT_SYNC_SIGNATURE_HEADER,
  BYOT_SYNC_TIMESTAMP_HEADER,
  isValidByotSyncSignature,
} from "../lib/byot-sync-internal-auth.js";
import { logger } from "./logging.js";

const INTERNAL_KEY_HEADER = "x-internal-service-key";

function readHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function timingSafeStringEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  try {
    return (
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"))
    );
  } catch {
    return false;
  }
}

async function handleByotSyncInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const platformKey = nonBlank(process.env.INTERNAL_SERVICE_KEY);
  if (platformKey && timingSafeStringEqual(readHeader(req, INTERNAL_KEY_HEADER), platformKey)) {
    next();
    return;
  }

  const signingSecret = nonBlank(process.env.BYOT_SYNC_INTERNAL_SIGNING_SECRET);
  if (!signingSecret) {
    logger.error("BYOT sync internal signing secret is not configured");
    res.status(503).json({ error: "Internal auth unavailable" });
    return;
  }

  if (isValidByotSyncSignature({
    body: req.body,
    secret: signingSecret,
    timestamp: readHeader(req, BYOT_SYNC_TIMESTAMP_HEADER),
    signature: readHeader(req, BYOT_SYNC_SIGNATURE_HEADER),
  })) {
    next();
    return;
  }

  logger.warn(`BYOT sync internal auth rejected from ${req.ip}`);
  res.status(401).json({ error: "Invalid internal auth" });
}

export function requireByotSyncInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  handleByotSyncInternalAuth(req, res, next).catch(next);
}
