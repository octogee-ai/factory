/**
 * Gitea API client — uses K8s DNS, no env var IPs.
 *
 * In-cluster: http://octogee-gitea-http.{namespace}.svc.cluster.local:3000
 * Local dev:  http://localhost:13000 (kubectl port-forward)
 *
 * Per-customer tokens: workspace routes use giteaApiAs() with the customer's
 * personal access token (stored in Firestore). The global GITEA_TOKEN is used
 * only for admin operations (sharing, provisioning) where no per-customer
 * token is appropriate.
 */
import { logger } from "../middleware/logging";

// K8s DNS — default for in-cluster. Override via env for local dev.
const GITEA_URL =
  process.env.GITEA_URL ||
  `http://octogee-gitea-http.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:3000`;

export const GITEA_ORG = process.env.GITEA_ORG || "octogee";

function getToken(): string {
  const token = process.env.GITEA_TOKEN;
  if (!token) throw new Error("GITEA_TOKEN not configured");
  return token;
}

/** Gitea API call using the global admin token. For admin operations only. */
export async function giteaApi(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  return giteaApiAs(getToken(), path, method, body);
}

/** Gitea API call using a specific token (per-customer or admin). */
export async function giteaApiAs(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
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

/** Gitea API call that returns null on 404 instead of throwing. */
export async function giteaApiAllowNotFound(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown | null> {
  const token = getToken();
  return giteaApiAsAllowNotFound(token, path, method, body);
}

/** Per-customer variant that returns null on 404. */
export async function giteaApiAsAllowNotFound(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
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
    if (resp.status === 404) return null;
    const text = await resp.text().catch(() => "");
    logger.error(`Gitea API error: ${resp.status} ${method} ${url}`, {
      response: text.slice(0, 500),
    });
    throw new Error(`Gitea API ${resp.status}`);
  }
  return resp.json();
}
