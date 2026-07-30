import { redactSecrets } from "./secret-redaction.js";
const ARGS_MAX = 120;
const OUTPUT_MAX = 160;
function collapseWhitespace(text) {
    return text.replace(/\s+/g, " ").trim();
}
function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}
function safeJson(value) {
    try {
        return JSON.stringify(value) ?? "";
    }
    catch {
        return "";
    }
}
/**
 * One-line preview of a tool's invocation args: a string verbatim, else the most
 * meaningful field (command/path/pattern/url/query), else compact JSON.
 * Redacted + truncated.
 */
export function summarizeToolArgs(args, max = ARGS_MAX) {
    if (args == null)
        return null;
    let raw;
    if (typeof args === "string") {
        raw = args;
    }
    else if (typeof args === "object") {
        const a = args;
        const preferred = a.command ?? a.cmd ?? a.file_path ?? a.path ?? a.pattern ?? a.query ?? a.url;
        raw = typeof preferred === "string" ? preferred : safeJson(args);
    }
    else {
        raw = String(args);
    }
    const out = truncate(redactSecrets(collapseWhitespace(raw)), max);
    return out.length > 0 ? out : null;
}
/** One-line preview of a tool's output. Redacted + truncated. */
export function summarizeToolOutput(output, max = OUTPUT_MAX) {
    if (typeof output !== "string" || output.length === 0)
        return null;
    const out = truncate(redactSecrets(collapseWhitespace(output)), max);
    return out.length > 0 ? out : null;
}
