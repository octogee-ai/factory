/**
 * `applyConfigPatch` — the single orchestrator every runtime writer uses to
 * mutate `openclaw.json` while the gateway is live. The only supported
 * write path is `config.patch` over the gateway's WS RPC. The pre-2026.4.24
 * file-write fallback was removed: `writeOpenClawConfig` triggers OpenClaw's
 * chokidar-backed hot-reload, which stops-and-restarts every tenant's MM
 * channel simultaneously. Under the cattle-gateway model that means a
 * multi-minute outage for everyone whenever the gateway is briefly
 * unreachable during a single restore. One slow customer should not bounce
 * the whole fleet.
 *
 * Error handling now:
 *   - TRANSIENT (connect-failed, timeout, rpc-error): retry forever with a
 *     capped exponential backoff. If the gateway genuinely never comes up,
 *     the fleet controller's health monitor flags the gateway and
 *     reassignments are the tool for that — not forging a file write.
 *   - HASH-MISMATCH: refetch the current hash and retry; also unbounded.
 *   - PERMANENT (auth-failed, invalid-patch, invalid-response): throw. These
 *     don't resolve by retrying — they mean the caller's buildPatch is
 *     broken, and a file-write would just bake the bad patch into
 *     openclaw.json and cascade into chokidar anyway.
 *
 * Callers that previously composed an in-place `fallback` mutator no longer
 * need one.
 */

import { OPENCLAW_CONFIG as _OPENCLAW_CONFIG, log as defaultLog } from "./config.js";
import {
  GatewayRpcError,
  createGatewayRpc,
  type GatewayRpcClient,
} from "./gateway-rpc.js";

// Kept imported for its side effect of declaring the config-path constant;
// no runtime use remains after the file-write fallback was removed.
void _OPENCLAW_CONFIG;

// ── Public API ──────────────────────────────────────────────────────────────

export interface ApplyConfigPatchArgs {
  /**
   * Build the merge-patch sent to `config.patch`. Receives the current
   * server-side snapshot (redacted — sensitive fields appear as placeholder
   * strings, which the server restores on apply). Compose the final array
   * here for array fields — OpenClaw treats a top-level array in the patch
   * as a wholesale replacement unless elements carry an `id`.
   */
  buildPatch: (current: unknown) => object;
  /** Prepended to diagnostic log lines for grep-ability. */
  logPrefix?: string;
}

export interface ApplyConfigPatchOptions {
  /** Inject a custom RPC client (tests). Default: one created from env. */
  rpc?: GatewayRpcClient;
  /** Inject a logger (tests). Default: scripts/lib/config.log. */
  log?: (msg: string) => void;
  /**
   * Initial backoff delay between transient retries. Each retry doubles
   * until it hits `retryBackoffMaxMs`, then holds there forever. Default
   * 2_000ms.
   */
  retryBackoffInitialMs?: number;
  /** Cap on the per-retry wait. Default 30_000ms. */
  retryBackoffMaxMs?: number;
  /**
   * Upper bound on retry attempts. Default `Infinity` — the gateway's
   * health monitors are what flag a genuinely-dead gateway, not this
   * retry loop. Tests inject a small finite value to exercise the
   * exhaustion path.
   */
  maxRetries?: number;
  /**
   * Sleep override for tests. Default: real setTimeout.
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface ApplyConfigPatchResult {
  /** Always "rpc". The field is kept so existing consumers that pattern-
   *  match on `mode` compile; it now has exactly one case. */
  mode: "rpc";
  /** Number of RPC attempts made (1 on first-try success). */
  attempts: number;
}

/**
 * Apply a config change via the gateway's `config.patch` RPC. Retries
 * transient failures forever with capped exponential backoff. Throws on
 * permanent failures or once `maxRetries` is exhausted.
 */
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

  // Own the rpc lifecycle: close it at the end when we created it ourselves.
  const rpc = opts.rpc ?? createGatewayRpc();
  const ownsRpc = !opts.rpc;

  const startedAt = Date.now();
  let attempts = 0;
  let currentBackoff = initialBackoff;

  try {
    while (true) {
      attempts++;
      const attemptStartedAt = Date.now();
      try {
        const getStart = Date.now();
        const { config, hash } = await rpc.configGet();
        const getMs = Date.now() - getStart;

        const patch = args.buildPatch(config);

        const patchStart = Date.now();
        await rpc.configPatch(patch, hash);
        const patchMs = Date.now() - patchStart;

        log(
          `${prefix}config.patch OK attempt=${attempts} configGet=${getMs}ms configPatch=${patchMs}ms totalMs=${Date.now() - startedAt}`,
        );
        return { mode: "rpc", attempts };
      } catch (err) {
        if (!(err instanceof GatewayRpcError)) {
          // Bug in caller's buildPatch — bubble.
          throw err;
        }

        const elapsed = Date.now() - attemptStartedAt;

        // Permanent → fail loudly. No file-write fallback to mask the bug.
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

        // Hash-mismatch → retry immediately, no backoff, no exhaustion.
        if (err.code === "hash-mismatch") {
          if (attempts >= maxRetries) {
            log(
              `⚠ ${prefix}config.patch hash-mismatch exhausted after attempts=${attempts} — bubbling`,
            );
            throw err;
          }
          log(
            `${prefix}config.patch attempt=${attempts} hash-mismatch after ${elapsed}ms — re-fetching hash and retrying immediately`,
          );
          continue;
        }

        // Transient (connect-failed, timeout, rpc-error) → retry with
        // capped exponential backoff. The retry loop is infinite by
        // default because the gateway's own health monitors handle the
        // "dead forever" case at a higher level — the right place, since
        // bouncing on file-write here is what broke prod 2026-04-23.
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
      } catch {
        // best-effort
      }
    }
  }
}
