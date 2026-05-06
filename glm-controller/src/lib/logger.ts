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

// `Map`s instead of plain objects — keyed lookups via `.get()` aren't
// flagged by `security/detect-object-injection` the way `obj[key]` is.
// Both shapes are equally type-safe at the call site (the keys are
// from a closed union); the Map shape is just lint-quiet.
type AnsiColor = "reset" | "dim" | "red" | "yellow" | "cyan" | "magenta" | "gray";

const ANSI = new Map<AnsiColor, string>([
  ["reset", "\x1b[0m"],
  ["dim", "\x1b[2m"],
  ["red", "\x1b[31m"],
  ["yellow", "\x1b[33m"],
  ["cyan", "\x1b[36m"],
  ["magenta", "\x1b[35m"],
  ["gray", "\x1b[90m"],
]);

const LEVEL_GLYPH = new Map<Level, string>([
  ["info", "ℹ"],
  ["warn", "⚠"],
  ["error", "✗"],
  ["debug", "·"],
]);

const LEVEL_COLOR = new Map<Level, AnsiColor>([
  ["info", "cyan"],
  ["warn", "yellow"],
  ["error", "red"],
  ["debug", "gray"],
]);

function paint(text: string, color: AnsiColor, enabled: boolean): string {
  if (!enabled) return text;
  // Bang-asserts are safe — color is typed to AnsiColor and ANSI is
  // populated with every variant of the union at module init.
  return `${ANSI.get(color)!}${text}${ANSI.get("reset")!}`;
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
  const glyph = paint(LEVEL_GLYPH.get(level)!, LEVEL_COLOR.get(level)!, color);
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
// Warn marker — split into two anchored patterns instead of one
// alternation regex. The previous combined pattern triggered a
// `sonarjs/slow-regex` warning over its alternation + nested
// quantifiers; two simple anchored regexes are both clearer and
// linear-time.
//   - bare:     `⚠ <body>`     — strips the glyph, body becomes the line
//   - prefixed: `[reaper] ⚠ x` — strips just the glyph + space, keeping
//                                the sub-system tag for context
const LEGACY_WARN_BARE = /^⚠\s*/;
const LEGACY_WARN_PREFIXED = /^(\[[^\]]+\]\s*)⚠\s*/;

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
      // Try prefixed first (`[reaper] ⚠ x`) so the sub-system tag is
      // preserved in the body; fall through to the bare form (`⚠ x`).
      const prefixedMatch = LEGACY_WARN_PREFIXED.exec(stripped);
      if (prefixedMatch) {
        const tag = prefixedMatch[1] ?? "";
        const body = tag + stripped.slice(prefixedMatch[0].length);
        console.warn(formatLine("warn", body, defaultMeta, fmtOpts));
        return;
      }
      const bareMatch = LEGACY_WARN_BARE.exec(stripped);
      if (bareMatch) {
        const body = stripped.slice(bareMatch[0].length);
        console.warn(formatLine("warn", body, defaultMeta, fmtOpts));
        return;
      }
      console.log(formatLine("info", stripped, defaultMeta, fmtOpts));
    },
  };
}
