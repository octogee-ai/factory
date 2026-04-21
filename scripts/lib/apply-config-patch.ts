/**
 * `applyConfigPatch` — the single orchestrator every runtime writer uses to
 * mutate `openclaw.json` while the gateway is live. Replaces direct
 * `writeOpenClawConfig` calls in the runtime paths per MM-MULTI-ACCOUNT-
 * FOLLOWUP-SPEC §7 (provisioner → config.patch RPC).
 *
 * Why this exists:
 *   The old flow was "write file + pray chokidar picks it up + flip
 *   chatmode to force a reload." It raced, dropped updates, and when it
 *   did fire, it stopped+restarted every tenant's MM WS. `config.patch`
 *   on the gateway is a deterministic single-call contract: validate +
 *   migrate + write + diff + per-path reload, server-side.
 *
 * What this does:
 *   1. Pulls the current on-disk config via `rpc.configGet()` so the
 *      caller can build a patch that references existing arrays/objects.
 *      (Bindings in particular need client-side merge — the server's
 *      mergeObjectArraysById key isn't present on bindings, so merge-patch
 *      would replace the whole array.)
 *   2. Calls `rpc.configPatch(patch, baseHash)`.
 *   3. If the server reports a hash mismatch, refetches and retries ONCE.
 *      One retry is enough given the provisioner is single-writer at the
 *      application level; a persistent mismatch means someone else is
 *      writing concurrently and the fallback path is safer.
 *   4. If the server returns a TRANSIENT error — connect-failed, timeout,
 *      or rpc-error — retries the whole flow with exponential backoff.
 *      The April 16 TEST signup showed the gateway's event loop can pin
 *      for 10-20s during plugin init; a single 10s client timeout
 *      sends us straight to file-write, which then misses the chokidar
 *      reload and leaves the new coach offline. Retries absorb that.
 *   5. On PERMANENT errors — auth-failed, invalid-patch, invalid-response
 *      — falls back to file-write immediately. No point retrying a schema
 *      failure.
 *
 * Non-GatewayRpcError exceptions (bugs in `buildPatch` / `fallback`) are
 * NOT caught. "No silent failures" per engineering principles — surfacing
 * bugs is the whole point of the orchestrator.
 */

import * as fs from "fs";
import { OPENCLAW_CONFIG, log as defaultLog, writeOpenClawConfig } from "./config.js";
import {
  GatewayRpcError,
  createGatewayRpc,
  type GatewayRpcClient,
  type GatewayRpcErrorCode,
} from "./gateway-rpc.js";

// ── Public API ──────────────────────────────────────────────────────────────

export interface ApplyConfigPatchArgs {
  /**
   * Build the merge-patch sent to `config.patch`. Receives the current
   * server-side snapshot (redacted — sensitive fields appear as placeholder
   * strings, which the server restores on apply). For patches that touch
   * arrays (e.g. `bindings[]`), compose the final array here using the
   * current state — OpenClaw treats a top-level array in the patch as a
   * wholesale replacement, not a merge, unless the elements carry an `id`.
   */
  buildPatch: (current: unknown) => object;
  /**
   * Apply the equivalent in-place mutation if we fall back to file-write.
   * Must produce the same on-disk result the RPC path would have. Runs
   * against a freshly-read `openclaw.json`, not the redacted snapshot, so
   * it can touch secrets directly.
   */
  fallback: (config: any) => void;
  /** Prepended to fallback/diagnostic log lines for grep-ability. */
  logPrefix?: string;
}

export interface ApplyConfigPatchOptions {
  /** Inject a custom RPC client (tests). Default: one created from env. */
  rpc?: GatewayRpcClient;
  /** Override the openclaw.json path (tests). Default: OPENCLAW_CONFIG. */
  configPath?: string;
  /** Inject a logger (tests). Default: scripts/lib/config.log. */
  log?: (msg: string) => void;
  /**
   * Backoff delays in ms between retry attempts on transient RPC errors.
   * Length = max retries after the first failure. Default: [2000, 10000]
   * — so up to 3 attempts at 0s, 2s, 12s elapsed (plus up to 30s inside
   * each attempt for the connect+call timeout).
   *
   * Why 3 attempts: TEST evidence from April 21 (`chris-test5` signup)
   * showed the gateway event loop can pin for 15–20s during provisioning
   * because of concurrent MM-client reconnects, which starves the WS
   * accept path and times out the connect handshake. Two attempts
   * (previously [2000]) exhausted before the pin cleared; the file-write
   * fallback then triggered a full channel restart that dropped every
   * existing tenant's WS. The third attempt at 12s-elapsed + 30s-timeout
   * gives the event loop up to 42s to clear before we give up — enough
   * to ride out the observed pin window without locking provisioning
   * indefinitely against a genuinely-dead gateway.
   */
  retryBackoffMs?: number[];
  /**
   * Sleep override for tests. Default: real setTimeout.
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface ApplyConfigPatchResult {
  mode: "rpc" | "fallback-file-write";
  /** Number of RPC attempts made (1 on first-try success, higher on retry). */
  attempts?: number;
  /**
   * On fallback only: classified reason for giving up on the RPC path.
   * Maps 1:1 to a GatewayRpcErrorCode from the last attempt, plus
   * `"hash-mismatch-exhausted"` for the hash-retry burn-out case. Exposed
   * so callers can emit structured telemetry / alerting on fallback
   * frequency without parsing the human-readable log line.
   */
  fallbackReasonCode?: GatewayRpcErrorCode | "hash-mismatch-exhausted";
  /**
   * On fallback only: total elapsed wall time (ms) in the RPC attempts
   * before we gave up. Pair with `fallbackReasonCode` for dashboards.
   */
  fallbackElapsedMs?: number;
}

/**
 * Categorize an RPC error as transient (retry), hash-mismatch (immediate
 * retry), or permanent (fall back). Keep the mapping here so callers don't
 * reason about error codes.
 */
function errorKind(code: GatewayRpcErrorCode): "transient" | "hash-mismatch" | "permanent" {
  switch (code) {
    case "connect-failed":
    case "timeout":
    case "rpc-error":
      // Connect + call timeouts are by far the most common during gateway
      // boot (event-loop pinned by plugin init). `rpc-error` is the
      // catch-all from the server — we retry once; persistent server-side
      // errors will surface on subsequent signups and we'll fix the root
      // cause.
      return "transient";
    case "hash-mismatch":
      return "hash-mismatch";
    case "auth-failed":
    case "invalid-patch":
    case "invalid-response":
      // These don't resolve by retrying — fall back to file-write
      // immediately and let the operator + next boot-sync reconcile.
      return "permanent";
  }
}

/**
 * Apply a config change via RPC if the gateway is reachable, or fall back
 * to atomic file-write if not. See the module-level comment for semantics.
 */
export async function applyConfigPatch(
  args: ApplyConfigPatchArgs,
  opts: ApplyConfigPatchOptions = {},
): Promise<ApplyConfigPatchResult> {
  const log = opts.log ?? defaultLog;
  const configPath = opts.configPath ?? OPENCLAW_CONFIG;
  const prefix = args.logPrefix ? `${args.logPrefix} ` : "";
  const backoff = opts.retryBackoffMs ?? [2_000, 10_000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Own the rpc lifecycle: close it at the end when we created it ourselves.
  const rpc = opts.rpc ?? createGatewayRpc();
  const ownsRpc = !opts.rpc;

  const startedAt = Date.now();
  const maxAttempts = backoff.length + 1; // initial + one per backoff entry
  let attempts = 0;
  let reason: string | null = null;
  // Classified, grep-able reason code for the structured [fallback-metric]
  // line. Set before we `break` out of the retry loop into fallback.
  let reasonCode: GatewayRpcErrorCode | "hash-mismatch-exhausted" | null = null;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      const attemptStartedAt = Date.now();
      try {
        const getStart = Date.now();
        const { config, hash } = await rpc.configGet();
        const getMs = Date.now() - getStart;

        const patch = args.buildPatch(config);

        const patchStart = Date.now();
        await rpc.configPatch(patch, hash);
        const patchMs = Date.now() - patchStart;

        // Success — emit a single-line timing trace so operators can
        // correlate applyConfigPatch elapsed-time against gateway-side
        // `[ws] ⇄ res ✓` lines on the same wall-clock.
        log(
          `${prefix}config.patch OK attempt=${attempt}/${maxAttempts} configGet=${getMs}ms configPatch=${patchMs}ms totalMs=${Date.now() - startedAt}`,
        );
        return { mode: "rpc", attempts };
      } catch (err) {
        if (!(err instanceof GatewayRpcError)) {
          // Bug in caller's buildPatch — bubble without touching fallback.
          throw err;
        }

        const kind = errorKind(err.code);
        const elapsed = Date.now() - attemptStartedAt;

        // Hash-mismatch retries aren't counted against the backoff budget;
        // they re-read the hash immediately.
        if (kind === "hash-mismatch") {
          if (attempt < maxAttempts) {
            log(
              `${prefix}config.patch attempt=${attempt} hash-mismatch after ${elapsed}ms — re-fetching hash and retrying immediately`,
            );
            continue;
          }
          reason = `retry exhausted (hash-mismatch x${maxAttempts}: ${err.message})`;
          reasonCode = "hash-mismatch-exhausted";
          break;
        }

        if (kind === "permanent") {
          reason = `${err.code} (permanent, no retry): ${err.message}`;
          reasonCode = err.code;
          break;
        }

        // Transient — log the attempt + back off before retrying.
        const backoffIdx = attempt - 1;
        if (backoffIdx < backoff.length) {
          const delay = backoff[backoffIdx];
          log(
            `${prefix}config.patch attempt=${attempt}/${maxAttempts} failed (${err.code}: ${err.message}) after ${elapsed}ms — retrying in ${delay}ms`,
          );
          await sleep(delay);
          continue;
        }
        reason = `retry exhausted (${err.code} x${maxAttempts}: ${err.message})`;
        reasonCode = err.code;
        break;
      }
    }

    const fallbackElapsedMs = Date.now() - startedAt;
    // Invariant: every `break` path out of the retry loop above sets
    // `reasonCode`, and the loop has no natural fall-through (each branch
    // either `continue`s or `break`s). If this throws, a new break path
    // was added that forgot to set `reasonCode` — fail loudly rather than
    // emitting `reason=unknown` in the metric stream, which would silently
    // hide the bug from ops dashboards.
    if (reasonCode === null) {
      throw new Error(
        "applyConfigPatch: retry loop exited with reasonCode=null — missing assignment on a new break path",
      );
    }
    log(
      `⚠ ${prefix}config.patch ${reason} totalMs=${fallbackElapsedMs} attempts=${attempts} — falling back to file-write. boot-sync will reconcile on next gateway restart.`,
    );
    // Structured, grep-able metric line paired with the human-readable warn
    // above. Ops scrapes `[fallback-metric]` out of the log stream to count
    // occurrences per reason code; dashboards key on the fields after the
    // tag. Emitted on EVERY fallback (transient-exhausted, hash-mismatch-
    // exhausted, or permanent) so the count reflects the truth without
    // having to reconstruct it from prose. Spec §7 acceptance: "Metric:
    // count of RPC-fallback events, surface in the Ops Dashboard."
    log(
      `[fallback-metric] applyConfigPatch.fallback reason=${reasonCode} attempts=${attempts} elapsedMs=${fallbackElapsedMs}`,
    );
    return {
      ...fileWriteFallback(args.fallback, configPath, log, prefix),
      attempts,
      fallbackReasonCode: reasonCode,
      fallbackElapsedMs,
    };
  } finally {
    if (ownsRpc) {
      try {
        await rpc.close();
      } catch {
        // close is best-effort
      }
    }
  }
}

// ── Fallback ────────────────────────────────────────────────────────────────

function fileWriteFallback(
  mutate: (config: any) => void,
  configPath: string,
  log: (msg: string) => void,
  prefix: string,
): ApplyConfigPatchResult {
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  mutate(config);
  // Route through writeOpenClawConfig so the atomic write+rename dance
  // lives in exactly one place (scripts/lib/config.ts). The `configPath`
  // override exists solely for tests that inject a temp path.
  writeOpenClawConfig(config, configPath);
  log(`${prefix}openclaw.json updated via file-write fallback`);
  return { mode: "fallback-file-write" };
}
