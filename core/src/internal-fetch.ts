import { readFile } from "node:fs/promises";

export const K8S_SA_TOKEN_HEADER = "x-k8s-sa-token";
export const DEFAULT_PROJECTED_API_TOKEN_PATH =
  "/var/run/secrets/octogee-api/token";

export interface InternalFetchOptions {
  internalServiceKey?: string;
  tokenPath?: string;
  fetchImpl?: typeof fetch;
}

async function readProjectedToken(tokenPath: string): Promise<string | null> {
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export async function internalFetch(
  url: string | URL,
  init: RequestInit = {},
  opts: InternalFetchOptions = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const internalServiceKey =
    opts.internalServiceKey ?? process.env.INTERNAL_SERVICE_KEY ?? "";
  if (internalServiceKey) {
    headers.set("X-Internal-Service-Key", internalServiceKey);
  }

  const token = await readProjectedToken(
    opts.tokenPath ?? process.env.OCTOGEE_API_SA_TOKEN_PATH ?? DEFAULT_PROJECTED_API_TOKEN_PATH,
  );
  if (token) headers.set(K8S_SA_TOKEN_HEADER, token);

  const fetchImpl = opts.fetchImpl ?? fetch;
  return fetchImpl(url, { ...init, headers });
}
