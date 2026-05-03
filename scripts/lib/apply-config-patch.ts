import { log as defaultLog } from "./config.js";
import {
  GatewayRpcError,
  createGatewayRpc,
  type GatewayRpcClient,
} from "./gateway-rpc.js";

export interface ApplyConfigPatchArgs {
  buildPatch: (current: unknown) => object;
  logPrefix?: string;
}

/**
 * Mutable single-slot cache so a long-running provisioner (e.g. the fleet
 * controller) can chain customer-add patches without paying ~5s of
 * `config.get` round-trip on every call. The cache is updated from the
 * `config.patch` response (which carries the post-write hash + merged
 * config). On hash-mismatch the cache is refreshed via `config.get` and the
 * patch retried.
 */
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
  sleep?: (ms: number) => Promise<void>;
  cache?: ConfigCache;
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
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const rpc = opts.rpc ?? createGatewayRpc();
  const ownsRpc = !opts.rpc;

  const startedAt = Date.now();
  let attempts = 0;
  let currentBackoff = initialBackoff;

  const cache = opts.cache;

  try {
    while (true) {
      attempts++;
      const attemptStartedAt = Date.now();
      try {
        let config: unknown;
        let hash: string;
        let getMs = 0;
        if (cache && cache.hash !== "" && cache.current !== undefined) {
          config = cache.current;
          hash = cache.hash;
        } else {
          const getStart = Date.now();
          const fetched = await rpc.configGet();
          getMs = Date.now() - getStart;
          config = fetched.config;
          hash = fetched.hash;
          if (cache) {
            cache.current = config;
            cache.hash = hash;
          }
        }

        const patch = args.buildPatch(config);

        const patchStart = Date.now();
        const patchResult = await rpc.configPatch(patch, hash);
        const patchMs = Date.now() - patchStart;

        if (cache) {
          if (typeof patchResult.hash === "string" && patchResult.hash.length > 0) {
            cache.hash = patchResult.hash;
            cache.current = patchResult.config ?? cache.current;
          } else {
            // Stock-OC or pre-fork-patch server. Mark stale so next call
            // pays a fresh configGet rather than reusing a now-bogus hash.
            cache.hash = "";
          }
        }

        log(
          `${prefix}config.patch OK attempt=${attempts} configGet=${getMs}ms configPatch=${patchMs}ms totalMs=${Date.now() - startedAt}`,
        );
        return { mode: "rpc", attempts };
      } catch (err) {
        if (!(err instanceof GatewayRpcError)) {
          throw err;
        }

        const elapsed = Date.now() - attemptStartedAt;

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
          if (attempts >= maxRetries) {
            log(
              `⚠ ${prefix}config.patch hash-mismatch exhausted after attempts=${attempts} — bubbling`,
            );
            throw err;
          }
          // Invalidate cache so the retry re-fetches via config.get rather
          // than re-trying the same stale hash in a loop.
          if (cache) {
            cache.hash = "";
            cache.current = undefined;
          }
          log(
            `${prefix}config.patch attempt=${attempts} hash-mismatch after ${elapsed}ms — re-fetching hash and retrying immediately`,
          );
          continue;
        }

        if (attempts >= maxRetries) {
          log(
            `⚠ ${prefix}config.patch retry exhausted (${err.code} x${attempts}: ${err.message}) totalMs=${Date.now() - startedAt} — bubbling`,
          );
          throw err;
        }
        log(
          `${prefix}config.patch attempt=${attempts} failed (${err.code}: ${err.message}) after ${elapsed}ms — retrying in ${currentBackoff}ms`,
        );
        await sleep(currentBackoff);
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
