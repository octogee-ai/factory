const REDACTED = "[redacted]";
// Patterns err toward over-redaction: a false positive costs a "[redacted]",
// a miss leaks a live credential. Specific shapes run before the generic
// long-run catchalls so the specific replacement wins where it applies.
const SECRET_PATTERNS = [
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
];
const LONG_TOKEN_CATCHALLS = [
    /\b[0-9a-fA-F]{40,}\b/g,
    /\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}\b/g,
];
const LONG_CREDENTIAL_PATTERNS = [
    [/((?:token|secret|auth|sig|signature|hmac)[\\"']{0,2}\s*[:=]\s*[\\"']{0,2})[^\s"'\\,;&}]{20,}/gi, `$1${REDACTED}`],
    [/((?:passw(?:or)?d|pwd|api[-_]?key)[\\"']{0,2}\s*[:=]\s*[\\"']{0,2})[^\s"'\\,;&}]{20,}/gi, `$1${REDACTED}`],
    [/((?:credentials?|private[-_]?key)[\\"']{0,2}\s*[:=]\s*[\\"']{0,2})[^\s"'\\,;&}]{20,}/gi, `$1${REDACTED}`],
    [/(cookie[\\"']{0,2}\s*[:=]\s*)\[[^\]\r\n]*\]?/gi, `$1${REDACTED}`],
    [/(cookie[\\"']{0,2}\s*[:=]\s*[\\"']{0,2})(?!\[redacted\])[^"'\\\r\n]+/gi, `$1${REDACTED}`],
    [/\b(Authorization[\\"']{0,2}\s*[:=]\s*[\\"']{0,2}(?:[a-z]+\s+)?)[^\s"'\\,;]{20,}/gi, `$1${REDACTED}`],
    [/\b((?:https?|ssh|git|postgres(?:ql)?|rediss?|mysql|amqps?):\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`],
];
const LABELED_SECRET_PATTERNS = [
    /\b((?:access|refresh|id|oauth)[-_]?token\s*[:=]\s*)[^\s,;&}]+/gi,
    /\b((?:api[-_]?key|client[-_]?secret)\s*[:=]\s*)[^\s,;&}]+/gi,
    /\b((?:password|credential)\s*[:=]\s*)[^\s,;&}]+/gi,
];
export function redactSecrets(value, options = {}) {
    const labeled = LABELED_SECRET_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, `$1${REDACTED}`), value);
    const named = applyPatterns(labeled, SECRET_PATTERNS);
    if (options.keepLongTokens)
        return applyPatterns(named, LONG_CREDENTIAL_PATTERNS);
    return LONG_TOKEN_CATCHALLS.reduce((redacted, pattern) => redacted.replace(pattern, REDACTED), named);
}
function applyPatterns(value, patterns) {
    return patterns.reduce((redacted, [pattern, replacement]) => redacted.replace(pattern, replacement), value);
}
function credentialField(key) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    return [
        "authorization", "cookie", "credential", "password",
        "privatekey", "secret", "token",
    ].some((suffix) => normalized === suffix || normalized.endsWith(suffix)) || normalized.endsWith("apikey");
}
export function redactStructuredSecrets(value, options = {}) {
    if (Array.isArray(value))
        return value.map(item => redactStructuredSecrets(item, options));
    if (!value || typeof value !== "object") {
        return typeof value === "string" ? redactSecrets(value, options) : value;
    }
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [
        key,
        credentialField(key) ? REDACTED : redactStructuredSecrets(field, options),
    ]));
}
