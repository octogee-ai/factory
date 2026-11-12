import * as crypto from "node:crypto";
import type { Provider } from "./provider-key-format.js";

const BYOT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function byotSecretName(slug: string, provider: Provider): string {
  if (!BYOT_SLUG_PATTERN.test(slug)) {
    throw new Error(`invalid slug ${JSON.stringify(slug)}`);
  }
  return `byok-${slug}-${provider}`;
}

export function keyFingerprintFor(key: string): string {
  if (!key) return "none";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

const KEY_FINGERPRINT_SECRET =
  process.env.BYOT_FINGERPRINT_SECRET ||
  process.env.INTERNAL_SERVICE_KEY ||
  "dev-only-placeholder";

export function keyHashFor(key: string): string {
  return crypto
    .createHmac("sha256", KEY_FINGERPRINT_SECRET)
    .update(key)
    .digest("hex")
    .slice(0, 12);
}
