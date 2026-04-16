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
 *   4. On any other RPC error — connect failed, auth failed, invalid
 *      patch, timeout, rpc-error — falls back to the legacy file-write
 *      path so provisioning completes, logs a structured warning, and
 *      lets the next `boot-sync` reconcile any drift.
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
}

export interface ApplyConfigPatchResult {
  mode: "rpc" | "fallback-file-write";
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

  // Own the rpc lifecycle: close it at the end when we created it ourselves.
  const rpc = opts.rpc ?? createGatewayRpc();
  const ownsRpc = !opts.rpc;

  try {
    // Resolve the patch attempt to either {kind:"ok"} or a fallback-reason
    // string that names why we're ditching the RPC path. Single call site
    // logs + runs fileWriteFallback — keeps the log-then-fallback contract
    // in one place instead of duplicating across branches.
    const MAX_ATTEMPTS = 2;
    let reason: string | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { config, hash } = await rpc.configGet();
        const patch = args.buildPatch(config);
        await rpc.configPatch(patch, hash);
        return { mode: "rpc" };
      } catch (err) {
        if (err instanceof GatewayRpcError && err.code === "hash-mismatch") {
          if (attempt < MAX_ATTEMPTS) continue; // optimistic retry
          reason = `retry exhausted (hash-mismatch x${MAX_ATTEMPTS}: ${err.message})`;
          break;
        }
        if (err instanceof GatewayRpcError) {
          reason = `RPC failed (${err.code}: ${err.message})`;
          break;
        }
        // Non-RPC error: let it bubble (bug in caller's buildPatch / fallback).
        throw err;
      }
    }
    log(
      `⚠ ${prefix}config.patch ${reason} — falling back to file-write. boot-sync will reconcile on next gateway restart.`,
    );
    return fileWriteFallback(args.fallback, configPath, log, prefix);
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
