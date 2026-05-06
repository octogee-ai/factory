/**
 * Cowboy's logger — color-coded, emoji-tagged, human-readable.
 *
 * Streamed through `kubectl logs` / `stern` alongside other services'
 * output, so every line carries the 🤠 cowboy badge so a human eye can
 * scan a multi-pod tail and spot which service emitted what.
 *
 * Three surfaces:
 *   - createLogger().info/warn/error/debug — structured callsites
 *   - createLogger().child(scope, emoji)   — sub-logger with default tag
 *   - createLogger().legacy(msg)           — drop-in for the existing
 *     `(msg: string) => void` shape used everywhere in handlers/.
 *     Detects the legacy `[glm-controller]` prefix and `⚠` warn marker,
 *     normalizes them through the same formatter so every line gets the
 *     timestamp + level glyph + cowboy badge automatically.
 */

type Level = "info" | "warn" | "error" | "debug";

export interface ScopeMeta {
  scope?: string;
  emoji?: string;
}

export interface FormatOptions {
  color?: boolean;
  /** Override clock for deterministic tests. */
  now?: () => Date;
}

export const COWBOY = "🤠 cowboy";

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

const LEVEL_GLYPH: Record<Level, string> = {
  info: "ℹ",
  warn: "⚠",
  error: "✗",
  debug: "·",
};

const LEVEL_COLOR: Record<Level, keyof typeof ANSI> = {
  info: "cyan",
  warn: "yellow",
  error: "red",
  debug: "gray",
};

function paint(text: string, color: keyof typeof ANSI, enabled: boolean): string {
  if (!enabled) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

export function formatLine(
  level: Level,
  message: string,
  meta: ScopeMeta | undefined,
  opts: FormatOptions,
): string {
  const color = opts.color !== false;
  const now = (opts.now ?? (() => new Date()))();
  const ts = paint(now.toISOString(), "gray", color);
  const glyph = paint(LEVEL_GLYPH[level], LEVEL_COLOR[level], color);
  const cowboy = paint(COWBOY, "magenta", color);
  const parts: string[] = [ts, glyph, cowboy];
  if (meta?.scope) {
    const scopeText = meta.emoji ? `${meta.emoji} ${meta.scope}` : `[${meta.scope}]`;
    parts.push(paint(scopeText, "dim", color));
  }
  parts.push(message);
  return parts.join("  ");
}

export interface Logger {
  info(message: string, meta?: ScopeMeta): void;
  warn(message: string, meta?: ScopeMeta): void;
  error(message: string, meta?: ScopeMeta): void;
  debug(message: string, meta?: ScopeMeta): void;
  child(scope: string, emoji?: string): Logger;
  /**
   * Backwards-compatible single-arg log shape. Detects the existing
   * `[glm-controller]` prefix (strips it — the cowboy badge replaces it)
   * and the `⚠` warn marker (routes the line through console.warn at the
   * warn level). Any other prefix (e.g. `[deprovision]`, `[mm]`) passes
   * through untouched as the message body.
   */
  legacy(message: string): void;
}

export interface CreateLoggerOptions extends FormatOptions {
  debug?: boolean;
}

const LEGACY_PREFIX = /^\[glm-controller\]\s*/;
const LEGACY_WARN_MARKER = /^⚠\s*/;

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const debugEnabled = opts.debug ?? false;
  const formatOpts: FormatOptions = { color: opts.color, now: opts.now };
  return makeLogger(undefined, formatOpts, debugEnabled);
}

function makeLogger(
  defaultMeta: ScopeMeta | undefined,
  fmtOpts: FormatOptions,
  debugEnabled: boolean,
): Logger {
  const merge = (m?: ScopeMeta): ScopeMeta | undefined => {
    if (!defaultMeta && !m) return undefined;
    return { ...defaultMeta, ...m };
  };
  return {
    info(message, meta) {
      console.log(formatLine("info", message, merge(meta), fmtOpts));
    },
    warn(message, meta) {
      console.warn(formatLine("warn", message, merge(meta), fmtOpts));
    },
    error(message, meta) {
      console.error(formatLine("error", message, merge(meta), fmtOpts));
    },
    debug(message, meta) {
      if (!debugEnabled) return;
      console.log(formatLine("debug", message, merge(meta), fmtOpts));
    },
    child(scope, emoji) {
      return makeLogger({ ...defaultMeta, scope, emoji }, fmtOpts, debugEnabled);
    },
    legacy(message) {
      const stripped = message.replace(LEGACY_PREFIX, "");
      if (LEGACY_WARN_MARKER.test(stripped)) {
        const body = stripped.replace(LEGACY_WARN_MARKER, "");
        console.warn(formatLine("warn", body, defaultMeta, fmtOpts));
        return;
      }
      console.log(formatLine("info", stripped, defaultMeta, fmtOpts));
    },
  };
}
