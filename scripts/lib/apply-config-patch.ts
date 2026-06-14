import { log as defaultLog } from "./config.js";
import {
  OpenclawWireError,
  createGatewayRpc,
  type GatewayRpcClient,
} from "./gateway-rpc.js";

export interface ApplyConfigPatchArgs {
  buildPatch: (current: unknown) => object;
  /** Paths to confirm against the gateway's destructive-array guard: config.patch rejects a
   *  patch whose merge would drop array entries unless each shrunk array's exact path is named
   *  in replacePaths. Recomputed per attempt against the freshly-fetched config (same contract
   *  as buildPatch, which it always accompanies on retry). */
  buildReplacePaths?: (current: unknown) => string[];
  logPrefix?: string;
}

export interface ConfigCache {
  current: unknown;
  hash: string;
}

export interface ApplyConfigPatchOptions {
  rpc?: GatewayRpcClient;
  log?: (msg: string) => void;
  retryBackoffInitialMs?: number;
  retryBackoffMaxMs?: number;
  maxRetries?: number;

totalDeadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  
  now?: () => number;
  cache?: ConfigCache;

signal?: AbortSignal;
}

const RETRY_AFTER_PATTERN = /\brate limit exceeded\b.*?\bretry after (\d+)s\b/i;

function parseRetryAfterMs(message: string): number | null {
  const match = RETRY_AFTER_PATTERN.exec(message);
  if (!match) return null;
  const seconds = Number.parseInt(match[1], 10);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

function seedCacheFromFetch(cache: ConfigCache | undefined, config: unknown, hash: string): void {
  if (!cache) return;
  cache.current = config;
  cache.hash = hash;
}

function updateCacheAfterPatch(
  cache: ConfigCache | undefined,
  patchResult: { hash?: unknown; config?: unknown },
): void {
  if (!cache) return;
  if (typeof patchResult.hash === "string" && patchResult.hash.length > 0) {
    cache.hash = patchResult.hash;
    cache.current = patchResult.config ?? cache.current;
    return;
  }
  cache.hash = "";
}

function invalidateCacheForHashMismatch(cache: ConfigCache | undefined): void {
  if (!cache) return;
  cache.hash = "";
  cache.current = undefined;
}

function handleHashMismatch(
  err: OpenclawWireError,
  ctx: {
    attempts: number;
    maxRetries: number;
    remainingMs: () => number;
    totalDeadlineMs: number;
    elapsed: number;
    cache: ConfigCache | undefined;
    log: (msg: string) => void;
    prefix: string;
  },
): void {
  if (ctx.attempts >= ctx.maxRetries) {
    ctx.log(
      `⚠ ${ctx.prefix}config.patch hash-mismatch exhausted after attempts=${ctx.attempts} — bubbling`,
    );
    throw err;
  }
  if (ctx.remainingMs() <= 0) {
    throw new Error(
      `${ctx.prefix}config.patch totalDeadlineMs=${ctx.totalDeadlineMs}ms exceeded after attempts=${ctx.attempts} (last error: hash-mismatch)`,
    );
  }
  invalidateCacheForHashMismatch(ctx.cache);
  ctx.log(
    `${ctx.prefix}config.patch attempt=${ctx.attempts} hash-mismatch after ${ctx.elapsed}ms — re-fetching hash and retrying immediately`,
  );
}

export interface ApplyConfigPatchResult {
  mode: "rpc";
  attempts: number;
}

export async function applyConfigPatch(
  args: ApplyConfigPatchArgs,
  opts: ApplyConfigPatchOptions = {},
): Promise<ApplyConfigPatchResult> {
  const log = opts.log ?? defaultLog;
  const prefix = args.logPrefix ? `${args.logPrefix} ` : "";
  const initialBackoff = opts.retryBackoffInitialMs ?? 2_000;
  const maxBackoff = opts.retryBackoffMaxMs ?? 30_000;
  const maxRetries = opts.maxRetries ?? Number.POSITIVE_INFINITY;
  const totalDeadlineMs = opts.totalDeadlineMs ?? Number.POSITIVE_INFINITY;
  const now = opts.now ?? Date.now;

const signalRef = opts.signal;
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        signalRef?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      }));

  const rpc = opts.rpc ?? createGatewayRpc({
    allowLegacyGatewayTokenFallback: true,
  });
  const ownsRpc = !opts.rpc;

  const startedAt = now();
  let attempts = 0;
  let currentBackoff = initialBackoff;

  const remainingMs = (): number => totalDeadlineMs - (now() - startedAt);

  const cache = opts.cache;
  const signal = opts.signal;
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const reason = signal.reason;
      throw reason instanceof Error
        ? reason
        : new Error(`${prefix}config.patch aborted: ${String(reason ?? "signal aborted")}`);
    }
  };

  try {
    throwIfAborted();
    while (true) {
      attempts++;
      const attemptStartedAt = now();
      try {
        let config: unknown;
        let hash: string;
        let getMs = 0;
        if (cache && cache.hash !== "" && cache.current !== undefined) {
          config = cache.current;
          hash = cache.hash;
        } else {
          const getStart = now();
          const fetched = await rpc.configGet();
          getMs = now() - getStart;
          config = fetched.config;
          hash = fetched.hash;
          seedCacheFromFetch(cache, config, hash);
        }

        const patch = args.buildPatch(config);
        const replacePaths = args.buildReplacePaths?.(config);

        const patchStart = now();
        const patchResult = await rpc.configPatch(
          patch,
          hash,
          replacePaths && replacePaths.length > 0 ? { replacePaths } : undefined,
        );
        const patchMs = now() - patchStart;

        updateCacheAfterPatch(cache, patchResult);

        log(
          `${prefix}config.patch OK attempt=${attempts} configGet=${getMs}ms configPatch=${patchMs}ms totalMs=${now() - startedAt}`,
        );
        return { mode: "rpc", attempts };
      } catch (err) {
        if (!(err instanceof OpenclawWireError)) {
          throw err;
        }

        const elapsed = now() - attemptStartedAt;

        if (
          err.code === "auth-failed" ||
          err.code === "invalid-patch" ||
          err.code === "invalid-response"
        ) {
          log(
            `⚠ ${prefix}config.patch ${err.code} (permanent) after ${elapsed}ms — giving up: ${err.message}`,
          );
          throw err;
        }

        if (err.code === "rpc-error" && /would remove entries from array path/i.test(err.message)) {
          log(
            `⚠ ${prefix}config.patch rejected by the destructive-array guard (permanent — identical retries cannot pass). ` +
              `The caller's buildReplacePaths must confirm every shrunk array path: ${err.message}`,
          );
          throw err;
        }

        if (err.code === "hash-mismatch") {
          handleHashMismatch(err, {
            attempts,
            maxRetries,
            remainingMs,
            totalDeadlineMs,
            elapsed,
            cache,
            log,
            prefix,
          });
          continue;
        }

        if (attempts >= maxRetries) {
          log(
            `⚠ ${prefix}config.patch retry exhausted (${err.code} x${attempts}: ${err.message}) totalMs=${now() - startedAt} — bubbling`,
          );
          throw err;
        }
        if (remainingMs() <= 0) {
          throw new Error(
            `${prefix}config.patch totalDeadlineMs=${totalDeadlineMs}ms exceeded after attempts=${attempts} (last error: ${err.code}: ${err.message})`,
          );
        }
        const serverHintMs = parseRetryAfterMs(err.message);
        if (err.code === "rpc-error" && serverHintMs == null && /retry/i.test(err.message)) {
          log(
            `⚠ ${prefix}config.patch rpc-error mentions "retry" but no parsed hint — server wording may have drifted (msg: ${err.message})`,
          );
        }
        const candidateBackoff = serverHintMs ?? currentBackoff;
        const clamped = Math.min(candidateBackoff, Math.max(0, remainingMs()));
        if (clamped <= 0) {
          throw new Error(
            `${prefix}config.patch totalDeadlineMs=${totalDeadlineMs}ms exceeded — no time left for backoff after attempts=${attempts} (last error: ${err.code}: ${err.message})`,
          );
        }
        const source = serverHintMs != null ? "server retry-after" : "exp backoff";
        log(
          `🟡 ${prefix}config.patch attempt=${attempts} failed (${err.code}: ${err.message}) after ${elapsed}ms — retrying in ${clamped}ms (${source})`,
        );
        await sleep(clamped);
        throwIfAborted();

currentBackoff = Math.min(currentBackoff * 2, maxBackoff);
      }
    }
  } finally {
    if (ownsRpc) {
      try {
        await rpc.close();
      } catch {}
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Mirrors the gateway's collectBaseArrayPaths (openclaw src/gateway/server-methods/config.ts):
// null-deleting an object via config.patch trips the destructive-array guard for EVERY array
// anywhere under the deleted object, each named by exact dot-path. Arrays are terminal — the
// guard does not recurse into their elements — and prototype-pollution keys are skipped,
// exactly as upstream's isBlockedObjectKey does.
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function collectArrayPathsUnder(value: unknown, prefix: string): string[] {
  if (Array.isArray(value)) return [prefix];
  if (!isPlainObject(value)) return [];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (BLOCKED_OBJECT_KEYS.has(key)) continue;
    paths.push(...collectArrayPathsUnder(child, `${prefix}.${key}`));
  }
  return paths;
}

/**
 * The replacePaths set a customer-scoped config patch must confirm: `bindings` (add, remove,
 * and activation all wholesale-replace it after filtering this agent's entries) plus every
 * array under the slug's MM account — the remove patch null-deletes the account object, and
 * the add/activation patches merge a rebuilt account fragment whose arrays (groupAllowFrom)
 * can legitimately shrink on re-ensure. Derived from `current` so it tracks the account's
 * actual shape; confirming a path that doesn't shrink is a no-op for the guard, and for
 * non-id-keyed arrays it does not alter merge semantics.
 */
export function customerConfigReplacePaths(current: unknown, slug: string): string[] {
  const accountId = `${slug}-coach`;
  const accounts = (
    current as { channels?: { mattermost?: { accounts?: Record<string, unknown> } } } | undefined
  )?.channels?.mattermost?.accounts;
  const account = isPlainObject(accounts) ? accounts[accountId] : undefined;
  return ["bindings", ...collectArrayPathsUnder(account, `channels.mattermost.accounts.${accountId}`)];
}
