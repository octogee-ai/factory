/**
 * Multi-provider key format validation.
 *
 * Phase 2 generalizes Phase 1's anthropic-only validator. Format-only —
 * the live probe (`provider-probe.ts`) is the authority on whether the
 * key actually works.
 *
 * For openai-compatible upstreams (OpenRouter, Groq, Mistral, Fireworks,
 * Together, etc.), key formats are entirely upstream-defined. We only
 * check non-empty + no whitespace; the probe does the rest.
 */
import { validateAnthropicKey, type KeyValidationResult } from "./anthropic-key-format";

export type Provider = "anthropic" | "openai" | "openai-compatible";

const SUPPORTED: Provider[] = ["anthropic", "openai", "openai-compatible"];

export function isSupportedProvider(input: unknown): input is Provider {
  return typeof input === "string" && (SUPPORTED as string[]).includes(input);
}

const OPENAI_PREFIXES = ["sk-proj-", "sk-svcacct-", "sk-"]; // longest first
const OPENAI_MIN_LENGTH = 32;

function validateOpenAi(input: unknown): KeyValidationResult {
  if (typeof input !== "string") return { valid: false, reason: "API key is required" };
  const trimmed = input.trim();
  if (!trimmed) return { valid: false, reason: "API key is required (empty)" };
  if (trimmed.startsWith("sk-ant-")) {
    return {
      valid: false,
      reason: "That looks like an Anthropic key — pick the Anthropic provider, not OpenAI",
    };
  }
  if (!OPENAI_PREFIXES.some((p) => trimmed.startsWith(p))) {
    return { valid: false, reason: 'OpenAI keys must start with "sk-" (or sk-proj- / sk-svcacct-)' };
  }
  if (trimmed.length < OPENAI_MIN_LENGTH) {
    return { valid: false, reason: "API key is too short (suspected truncation)" };
  }
  if (/\s/.test(trimmed)) {
    return { valid: false, reason: "API key contains whitespace" };
  }
  return { valid: true, normalized: trimmed };
}

function validateOpenAiCompatible(input: unknown): KeyValidationResult {
  // OpenRouter, Groq, Mistral, Fireworks, Together — formats vary
  // wildly. The upstream probe will reject bad keys; format check just
  // catches whitespace junk and empty strings.
  if (typeof input !== "string") return { valid: false, reason: "API key is required" };
  const trimmed = input.trim();
  if (!trimmed) return { valid: false, reason: "API key is required (empty)" };
  if (/\s/.test(trimmed)) return { valid: false, reason: "API key contains whitespace" };
  return { valid: true, normalized: trimmed };
}

export function validateProviderKey(provider: Provider, input: unknown): KeyValidationResult {
  switch (provider) {
    case "anthropic":         return validateAnthropicKey(input);
    case "openai":            return validateOpenAi(input);
    case "openai-compatible": return validateOpenAiCompatible(input);
    default:                  return { valid: false, reason: `Unsupported provider: ${provider}` };
  }
}
