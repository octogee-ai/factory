import * as crypto from "node:crypto";

export const BYOT_SYNC_TIMESTAMP_HEADER = "x-byot-sync-timestamp";
export const BYOT_SYNC_SIGNATURE_HEADER = "x-byot-sync-signature";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, val]) => val !== undefined && typeof val !== "function" && typeof val !== "symbol")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function signatureFor(body: unknown, timestamp: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${canonicalJson(body)}`)
    .digest("hex");
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

export function createByotSyncAuthHeaders(args: {
  body: unknown;
  secret: string;
  nowMs?: number;
}): Record<string, string> {
  const secret = args.secret.trim();
  if (!secret) throw new Error("BYOT_SYNC_INTERNAL_SIGNING_SECRET is required for BYOT sync");
  const timestamp = `${Math.floor(args.nowMs ?? Date.now())}`;
  return {
    [BYOT_SYNC_TIMESTAMP_HEADER]: timestamp,
    [BYOT_SYNC_SIGNATURE_HEADER]: signatureFor(args.body, timestamp, secret),
  };
}

export function isValidByotSyncSignature(args: {
  body: unknown;
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  nowMs?: number;
}): boolean {
  const secret = args.secret.trim();
  if (!secret || !args.timestamp || !args.signature) return false;
  const timestampMs = Number(args.timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  if (Math.abs((args.nowMs ?? Date.now()) - timestampMs) > MAX_CLOCK_SKEW_MS) return false;
  return timingSafeStringEqual(args.signature, signatureFor(args.body, args.timestamp, secret));
}
