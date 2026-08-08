import { readFile } from "node:fs/promises";

export const K8S_SA_TOKEN_HEADER = "x-k8s-sa-token";
export const DEFAULT_PROJECTED_API_TOKEN_PATH =
  "/var/run/secrets/octogee-api/token";
export const DEFAULT_INTERNAL_FETCH_TIMEOUT_MS = 60_000;

export interface InternalFetchOptions {
  internalServiceKey?: string;
  tokenPath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
  requireProjectedToken?: boolean;
}

async function readProjectedToken(tokenPath: string): Promise<string | null> {
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function buildHeaders(
  init: RequestInit,
  opts: InternalFetchOptions,
): Promise<Headers> {
  const headers = new Headers(init.headers);
  const internalServiceKey =
    opts.internalServiceKey ?? process.env.INTERNAL_SERVICE_KEY ?? "";
  if (internalServiceKey) {
    headers.set("X-Internal-Service-Key", internalServiceKey);
  }
  const token = await readProjectedToken(
    opts.tokenPath ?? process.env.OCTOGEE_API_SA_TOKEN_PATH ?? DEFAULT_PROJECTED_API_TOKEN_PATH,
  );
  if (opts.requireProjectedToken && !token) {
    throw new Error("projected service-account token unavailable");
  }
  if (token) headers.set(K8S_SA_TOKEN_HEADER, token);
  return headers;
}

function resolveTimeoutMs(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number | undefined,
): number | undefined {
  if (timeoutMs !== undefined) return timeoutMs;
  return callerSignal ? undefined : DEFAULT_INTERNAL_FETCH_TIMEOUT_MS;
}

function boundSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number | undefined,
  timeoutSignal: (timeoutMs: number) => AbortSignal,
): { signal?: AbortSignal; timeout?: AbortSignal } {
  if (timeoutMs === undefined) return { signal: callerSignal ?? undefined };
  const timeout = timeoutSignal(timeoutMs);
  return {
    signal: callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout,
    timeout,
  };
}

export async function internalFetch(
  url: string | URL,
  init: RequestInit = {},
  opts: InternalFetchOptions = {},
): Promise<Response> {
  const headers = await buildHeaders(init, opts);
  const callerSignal = init.signal;
  const timeoutMs = resolveTimeoutMs(callerSignal, opts.timeoutMs);
  const { signal, timeout } = boundSignal(
    callerSignal,
    timeoutMs,
    opts.timeoutSignal ?? AbortSignal.timeout,
  );

  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    return await fetchImpl(url, { ...init, headers, ...(signal ? { signal } : {}) });
  } catch (err) {
    if (timeout?.aborted && !callerSignal?.aborted) {
      throw new Error(
        `internal-fetch: ${init.method ?? "GET"} ${String(url)} timed out after ${timeoutMs}ms`,
        { cause: err },
      );
    }
    throw err;
  }
}
