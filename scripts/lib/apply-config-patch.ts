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

export interface ApplyConfigPatchOptions {
  rpc?: GatewayRpcClient;
  log?: (msg: string) => void;
  retryBackoffInitialMs?: number;
  retryBackoffMaxMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
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
