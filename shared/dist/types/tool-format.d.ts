/**
 * One-line preview of a tool's invocation args: a string verbatim, else the most
 * meaningful field (command/path/pattern/url/query), else compact JSON.
 * Redacted + truncated.
 */
export declare function summarizeToolArgs(args: unknown, max?: number): string | null;
/** One-line preview of a tool's output. Redacted + truncated. */
export declare function summarizeToolOutput(output: unknown, max?: number): string | null;
