/**
 * Gitea API client — uses K8s DNS, no env var IPs.
 *
 * Per-customer tokens: workspace routes use giteaApiAs() with the customer's
 * personal access token (stored in Firestore). The global GITEA_TOKEN is used
 * only for admin operations (sharing, provisioning).
 */
import { logger } from "../middleware/logging";

const GITEA_URL =
  process.env.GITEA_URL ||
  `http://octogee-gitea-http.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:3000`;

export const GITEA_ORG = process.env.GITEA_ORG || "octogee";

function getToken(): string {
  const token = process.env.GITEA_TOKEN;
  if (!token) throw new Error("GITEA_TOKEN not configured");
  return token;
}

/** Core fetch — all public functions delegate here. */
async function giteaFetch(
  token: string,
  path: string,
  method: string,
  body: unknown | undefined,
  allow404: boolean,
): Promise<unknown | null> {
  const url = `${GITEA_URL}/api/v1/repos/${GITEA_ORG}/${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!resp.ok) {
    if (allow404 && resp.status === 404) return null;
    const text = await resp.text().catch(() => "");
    if (resp.status !== 404) {
      logger.error(`Gitea API error: ${resp.status} ${method} ${url}`, {
        response: text.slice(0, 500),
      });
    }
    throw new Error(`Gitea API ${resp.status}`);
  }
  return resp.json();
}

/** Global admin token. For admin operations only (sharing, provisioning). */
export async function giteaApi(path: string, method = "GET", body?: unknown): Promise<unknown> {
  return giteaFetch(getToken(), path, method, body, false) as Promise<unknown>;
}

/** Per-customer token. */
export async function giteaApiAs(token: string, path: string, method = "GET", body?: unknown): Promise<unknown> {
  return giteaFetch(token, path, method, body, false) as Promise<unknown>;
}

/** Global admin token, returns null on 404. */
async function giteaApiAllowNotFound(path: string, method = "GET", body?: unknown): Promise<unknown | null> {
  return giteaFetch(getToken(), path, method, body, true);
}

/** Per-customer token, returns null on 404. */
export async function giteaApiAsAllowNotFound(token: string, path: string, method = "GET", body?: unknown): Promise<unknown | null> {
  return giteaFetch(token, path, method, body, true);
}
