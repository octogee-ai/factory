import { logger } from "../middleware/logging";

const GITEA_URL =
  process.env.GITEA_URL ||
  `http://octogee-gitea-http.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:3000`;

export const GITEA_ORG = process.env.GITEA_ORG || "octogee";

const GITEA_HOST = (() => {
  try { return new URL(GITEA_URL).host; } catch { return ""; }
})();

function assertGiteaUrl(url: string): void {
  let host: string;
  try { host = new URL(url).host; } catch { throw new Error(`Invalid Gitea URL: ${url}`); }
  if (!GITEA_HOST || host !== GITEA_HOST) {
    throw new Error(`Refusing off-Gitea fetch: ${host} !== ${GITEA_HOST}`);
  }
}

function getToken(): string {
  const token = process.env.GITEA_TOKEN;
  if (!token) throw new Error("GITEA_TOKEN not configured");
  return token;
}

async function giteaFetch(
  token: string,
  path: string,
  method: string,
  body: unknown | undefined,
  allow404: boolean,
): Promise<unknown | null> {
  const url = `${GITEA_URL}/api/v1/repos/${GITEA_ORG}/${path}`;
  assertGiteaUrl(url);
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

export async function giteaApi(path: string, method = "GET", body?: unknown): Promise<unknown> {
  return giteaFetch(getToken(), path, method, body, false) as Promise<unknown>;
}

export async function giteaApiAs(token: string, path: string, method = "GET", body?: unknown): Promise<unknown> {
  return giteaFetch(token, path, method, body, false) as Promise<unknown>;
}

async function giteaApiAllowNotFound(path: string, method = "GET", body?: unknown): Promise<unknown | null> {
  return giteaFetch(getToken(), path, method, body, true);
}

export async function giteaApiAsAllowNotFound(token: string, path: string, method = "GET", body?: unknown): Promise<unknown | null> {
  return giteaFetch(token, path, method, body, true);
}

/**
 * Delete a Gitea repo. Idempotent — 404 (already gone) is treated as
 * success. Used by the per-project DELETE endpoint and by any future
 * one-off cleanup; the customer-level deprovision flow uses
 * `glm-controller`'s GiteaCleanupClient instead.
 *
 * IMPORTANT: `giteaFetch` already prefixes `${GITEA_URL}/api/v1/repos/${GITEA_ORG}/`
 * — pass the bare repo name (or `<repo>/<sub>`), NOT a leading `/repos/<org>/`.
 * Earlier draft of this helper double-prefixed and silently 404'd.
 */
export async function giteaDeleteRepo(repo: string): Promise<void> {
  await giteaApiAllowNotFound(encodeURIComponent(repo), "DELETE");
}

async function giteaAdminFetch(
  method: string,
  url: string,
  body: unknown | undefined,
  allow404: boolean,
): Promise<unknown | null> {
  assertGiteaUrl(url);
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `token ${getToken()}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!resp.ok) {
    if (allow404 && resp.status === 404) return null;
    const text = await resp.text().catch(() => "");
    logger.error(`Gitea admin error: ${resp.status} ${method} ${url}`, {
      response: text.slice(0, 500),
    });
    const err = new Error(`Gitea API ${resp.status}: ${text.slice(0, 200)}`) as Error & { status: number };
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

export async function createProjectGiteaRepo(
  repoName: string,
  description: string,
  privateRepo: boolean,
): Promise<void> {
  const url = `${GITEA_URL}/api/v1/orgs/${GITEA_ORG}/repos`;
  try {
    await giteaAdminFetch("POST", url, {
      name: repoName,
      description,
      private: privateRepo,
      auto_init: true,
      default_branch: "main",
    }, false);
  } catch (err) {
    if ((err as Error & { status?: number })?.status === 409) return;
    throw err;
  }
}

export async function giteaWriteFile(
  repoName: string,
  filePath: string,
  content: string,
  commitMessage: string,
): Promise<void> {
  const url = `${GITEA_URL}/api/v1/repos/${GITEA_ORG}/${repoName}/contents/${filePath}`;
  const existing = await giteaAdminFetch("GET", url, undefined, true);
  if (existing !== null) return;
  await giteaAdminFetch("POST", url, {
    message: commitMessage,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch: "main",
  }, false);
}
