/**
 * Format validation for a customer-supplied Anthropic API key, before we
 * spend an Anthropic round-trip probing it.
 *
 * Only a format check — a well-formed key may still be invalid / revoked.
 * The caller is expected to follow up with a 1-token `POST /v1/messages`
 * probe (see `anthropic-probe.ts`) before persisting.
 */

export interface KeyValidationResult {
  valid: boolean;
  reason?: string;
  /** Trimmed key; only set when `valid === true`. */
  normalized?: string;
}

const ANTHROPIC_PREFIX = "sk-ant-";
const MIN_LENGTH = 32;

export function validateAnthropicKey(input: unknown): KeyValidationResult {
  if (typeof input !== "string") {
    return { valid: false, reason: "API key is required" };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, reason: "API key is required (empty)" };
  }
  if (!trimmed.startsWith(ANTHROPIC_PREFIX)) {
    return {
      valid: false,
      reason: `Anthropic keys must start with "${ANTHROPIC_PREFIX}"`,
    };
  }
  if (trimmed.length < MIN_LENGTH) {
    return { valid: false, reason: "API key is too short (suspected truncation)" };
  }
  if (/\s/.test(trimmed)) {
    return { valid: false, reason: "API key contains whitespace" };
  }
  return { valid: true, normalized: trimmed };
}
