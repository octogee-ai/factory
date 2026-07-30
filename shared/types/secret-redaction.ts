const REDACTED = "[redacted]";

// Patterns err toward over-redaction: a false positive costs a "[redacted]",
// a miss leaks a live credential. Specific shapes run before the generic
// long-run catchalls so the specific replacement wins where it applies.
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, REDACTED],
  [/\b(Authorization\s*[:=]\s*Basic\s+)[-a-z0-9._~+/=]{8,}/gi, `$1${REDACTED}`],
  [/\b(Authorization\s*[:=]\s*Bearer\s+)[-a-z0-9._~+/=]{8,}/gi, `$1${REDACTED}`],
  [/\b(Bearer\s+)[-a-z0-9._~+/=]{12,}/gi, `$1${REDACTED}`],
  [/\b(Cookie\s*[:=]\s*)[^\r\n]+/gi, `$1${REDACTED}`],
  [/\b(Set-Cookie\s*[:=]\s*)[^\r\n]+/gi, `$1${REDACTED}`],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgh[opusr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_\w{20,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  [/\b[0-9a-fA-F]{40,}\b/g, REDACTED],
  [/\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}\b/g, REDACTED],
];

const LABELED_SECRET_PATTERNS = [
  /\b((?:access|refresh|id|oauth)[-_]?token\s*[:=]\s*)[^\s,;&}]+/gi,
  /\b((?:api[-_]?key|client[-_]?secret)\s*[:=]\s*)[^\s,;&}]+/gi,
  /\b((?:password|credential)\s*[:=]\s*)[^\s,;&}]+/gi,
];

export function redactSecrets(value: string): string {
  const labeled = LABELED_SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, `$1${REDACTED}`),
    value,
  );
  return SECRET_PATTERNS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    labeled,
  );
}

function credentialField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [
    "authorization", "cookie", "credential", "password",
    "privatekey", "secret", "token",
  ].some((suffix) => normalized === suffix || normalized.endsWith(suffix)) || normalized.endsWith("apikey");
}

export function redactStructuredSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructuredSecrets);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactSecrets(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, field]) => [
      key,
      credentialField(key) ? REDACTED : redactStructuredSecrets(field),
    ]),
  );
}
