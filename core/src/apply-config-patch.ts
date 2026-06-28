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

export interface ConfigPatchRetryPlan {
  delayMs: number;
  missingRetryAfterHint: boolean;
  source: "server retry-after" | "exp backoff";
}

export function configPatchRetryPlan(
  err: OpenclawWireError,
  currentBackoffMs: number,
  remainingMs: number,
): ConfigPatchRetryPlan {
  const serverHintMs = parseRetryAfterMs(err.message);
  const source = serverHintMs != null ? "server retry-after" : "exp backoff";
  const candidateBackoff = serverHintMs ?? currentBackoffMs;
  return {
    delayMs: Math.min(candidateBackoff, Math.max(0, remainingMs)),
    missingRetryAfterHint:
      err.code === "rpc-error" && serverHintMs == null && /retry/i.test(err.message),
    source,
  };
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

function createAbortableSleep(
  signal: AbortSignal | undefined,
  providedSleep: ((ms: number) => Promise<void>) | undefined,
): (ms: number) => Promise<void> {
  return (
    providedSleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      }))
  );
}

function throwIfConfigPatchAborted(signal: AbortSignal | undefined, prefix: string): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error
    ? reason
    : new Error(`${prefix}config.patch aborted: ${String(reason ?? "signal aborted")}`);
}

function configPatchReplacePathOptions(
  replacePaths: string[] | undefined,
): { replacePaths: string[] } | undefined {
  return replacePaths && replacePaths.length > 0 ? { replacePaths } : undefined;
}

async function readConfigForPatch(
  rpc: GatewayRpcClient,
  cache: ConfigCache | undefined,
  now: () => number,
): Promise<{ config: unknown; hash: string; getMs: number }> {
  if (cache && cache.hash !== "" && cache.current !== undefined) {
    return { config: cache.current, hash: cache.hash, getMs: 0 };
  }
  const getStart = now();
  const fetched = await rpc.configGet();
  seedCacheFromFetch(cache, fetched.config, fetched.hash);
  return { config: fetched.config, hash: fetched.hash, getMs: now() - getStart };
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

async function runConfigPatchAttempt(
  args: ApplyConfigPatchArgs,
  ctx: {
    attempts: number;
    cache: ConfigCache | undefined;
    log: (msg: string) => void;
    now: () => number;
    prefix: string;
    rpc: GatewayRpcClient;
    startedAt: number;
  },
): Promise<ApplyConfigPatchResult> {
  const { config, hash, getMs } = await readConfigForPatch(ctx.rpc, ctx.cache, ctx.now);
  const patch = args.buildPatch(config);
  const replacePaths = args.buildReplacePaths?.(config);
  const patchStart = ctx.now();
  const patchResult = await ctx.rpc.configPatch(
    patch,
    hash,
    configPatchReplacePathOptions(replacePaths),
  );
  const patchMs = ctx.now() - patchStart;

  updateCacheAfterPatch(ctx.cache, patchResult);

  ctx.log(
    `${ctx.prefix}config.patch OK attempt=${ctx.attempts} configGet=${getMs}ms configPatch=${patchMs}ms totalMs=${ctx.now() - ctx.startedAt}`,
  );
  return {
    mode: "rpc",
    attempts: ctx.attempts,
    ...(patchResult.noop === true ? { noop: true } : {}),
  };
}

function isPermanentConfigPatchError(err: OpenclawWireError): boolean {
  return (
    err.code === "auth-failed" ||
    err.code === "invalid-patch" ||
    err.code === "invalid-response"
  );
}

function isDestructiveArrayGuardError(err: OpenclawWireError): boolean {
  return err.code === "rpc-error" && /would remove entries from array path/i.test(err.message);
}

function throwIfPermanentConfigPatchFailure(
  err: OpenclawWireError,
  ctx: { elapsed: number; log: (msg: string) => void; prefix: string },
): void {
  if (isPermanentConfigPatchError(err)) {
    ctx.log(
      `⚠ ${ctx.prefix}config.patch ${err.code} (permanent) after ${ctx.elapsed}ms — giving up: ${err.message}`,
    );
    throw err;
  }

  if (isDestructiveArrayGuardError(err)) {
    ctx.log(
      `⚠ ${ctx.prefix}config.patch rejected by the destructive-array guard (permanent — identical retries cannot pass). ` +
        `The caller's buildReplacePaths must confirm every shrunk array path: ${err.message}`,
    );
    throw err;
  }
}

function throwIfConfigPatchRetryUnavailable(
  err: OpenclawWireError,
  ctx: {
    attempts: number;
    maxRetries: number;
    remainingMs: () => number;
    startedAt: number;
    totalDeadlineMs: number;
    now: () => number;
    log: (msg: string) => void;
    prefix: string;
  },
): void {
  if (ctx.attempts >= ctx.maxRetries) {
    ctx.log(
      `⚠ ${ctx.prefix}config.patch retry exhausted (${err.code} x${ctx.attempts}: ${err.message}) totalMs=${ctx.now() - ctx.startedAt} — bubbling`,
    );
    throw err;
  }
  if (ctx.remainingMs() <= 0) {
    throw new Error(
      `${ctx.prefix}config.patch totalDeadlineMs=${ctx.totalDeadlineMs}ms exceeded after attempts=${ctx.attempts} (last error: ${err.code}: ${err.message})`,
    );
  }
}

async function handleConfigPatchFailure(
  err: OpenclawWireError,
  ctx: {
    attemptStartedAt: number;
    attempts: number;
    cache: ConfigCache | undefined;
    currentBackoff: number;
    log: (msg: string) => void;
    maxBackoff: number;
    maxRetries: number;
    now: () => number;
    prefix: string;
    remainingMs: () => number;
    sleep: (ms: number) => Promise<void>;
    startedAt: number;
    throwIfAborted: () => void;
    totalDeadlineMs: number;
  },
): Promise<number> {
  const elapsed = ctx.now() - ctx.attemptStartedAt;
  throwIfPermanentConfigPatchFailure(err, { elapsed, log: ctx.log, prefix: ctx.prefix });

  if (err.code === "hash-mismatch") {
    handleHashMismatch(err, { ...ctx, elapsed });
    return ctx.currentBackoff;
  }

  throwIfConfigPatchRetryUnavailable(err, ctx);
  const retryPlan = configPatchRetryPlan(err, ctx.currentBackoff, ctx.remainingMs());
  if (retryPlan.missingRetryAfterHint) {
    ctx.log(
      `⚠ ${ctx.prefix}config.patch rpc-error mentions "retry" but no parsed hint — server wording may have drifted (msg: ${err.message})`,
    );
  }
  if (retryPlan.delayMs <= 0) {
    throw new Error(
      `${ctx.prefix}config.patch totalDeadlineMs=${ctx.totalDeadlineMs}ms exceeded — no time left for backoff after attempts=${ctx.attempts} (last error: ${err.code}: ${err.message})`,
    );
  }
  ctx.log(
    `🟡 ${ctx.prefix}config.patch attempt=${ctx.attempts} failed (${err.code}: ${err.message}) after ${elapsed}ms — retrying in ${retryPlan.delayMs}ms (${retryPlan.source})`,
  );
  await ctx.sleep(retryPlan.delayMs);
  ctx.throwIfAborted();
  return Math.min(ctx.currentBackoff * 2, ctx.maxBackoff);
}

export interface ApplyConfigPatchResult {
  mode: "rpc";
  attempts: number;
  noop?: boolean;
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
  const signal = opts.signal;
  const sleep = createAbortableSleep(signal, opts.sleep);
  const rpc = opts.rpc ?? createGatewayRpc({
    allowLegacyGatewayTokenFallback: true,
  });
  const ownsRpc = !opts.rpc;

  const startedAt = now();
  let attempts = 0;
  let currentBackoff = initialBackoff;

  const remainingMs = (): number => totalDeadlineMs - (now() - startedAt);
  const cache = opts.cache;
  const throwIfAborted = () => throwIfConfigPatchAborted(signal, prefix);

  try {
    throwIfAborted();
    while (true) {
      attempts++;
      const attemptStartedAt = now();
      try {
        return await runConfigPatchAttempt(args, {
          attempts,
          cache,
          log,
          now,
          prefix,
          rpc,
          startedAt,
        });
      } catch (err) {
        if (!(err instanceof OpenclawWireError)) {
          throw err;
        }
        currentBackoff = await handleConfigPatchFailure(err, {
          attemptStartedAt,
          attempts,
          cache,
          currentBackoff,
          log,
          maxBackoff,
          maxRetries,
          now,
          prefix,
          remainingMs,
          sleep,
          startedAt,
          throwIfAborted,
          totalDeadlineMs,
        });
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

export function upsertAgentInFullAgentList(
  current: unknown,
  agentId: string,
  agentEntry: unknown,
): unknown[] {
  const list = (current as { agents?: { list?: unknown } } | undefined)?.agents?.list;
  const currentAgents = Array.isArray(list) ? list : [];
  return [
    ...currentAgents.filter(
      (agent) => !(isPlainObject(agent) && agent.id === agentId),
    ),
    agentEntry,
  ];
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

function customerMattermostAccountArrayPaths(current: unknown, slug: string): string[] {
  const accountId = `${slug}-coach`;
  const accounts = (
    current as { channels?: { mattermost?: { accounts?: Record<string, unknown> } } } | undefined
  )?.channels?.mattermost?.accounts;
  const account = isPlainObject(accounts) ? accounts[accountId] : undefined;
  return collectArrayPathsUnder(account, `channels.mattermost.accounts.${accountId}`);
}

/**
 * The replacePaths set for customer config patches that rebuild non-id arrays:
 * `bindings` plus every array under the slug's MM account. Add/re-ensure patches
 * intentionally omit `agents.list` so a one-agent upsert stays an id-keyed merge
 * instead of becoming whole-list replacement.
 */
export function customerConfigReplacePaths(current: unknown, slug: string): string[] {
  return [
    "bindings",
    ...customerMattermostAccountArrayPaths(current, slug),
  ];
}

/**
 * The replacePaths set for customer config patches that intentionally ship the full
 * post-filter `agents.list` from the current config. Only use this when the patch's
 * `agents.list` is a complete replacement candidate, not a single-agent upsert.
 */
export function customerConfigFullAgentListReplacePaths(current: unknown, slug: string): string[] {
  return [
    "agents.list",
    ...customerConfigReplacePaths(current, slug),
  ];
}
