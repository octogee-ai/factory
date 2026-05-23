import { log as defaultLog } from "./config.js";
import {
  OpenclawWireError,
  createGatewayRpc,
  type GatewayRpcClient,
} from "./gateway-rpc.js";

export interface ApplyConfigPatchArgs {
  buildPatch: (current: unknown) => object;
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

  const rpc = opts.rpc ?? createGatewayRpc();
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

        const patchStart = now();
        const patchResult = await rpc.configPatch(patch, hash);
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
