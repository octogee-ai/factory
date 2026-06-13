import { logger } from "../middleware/logging.js";

const GITEA_URL =
  process.env.GITEA_URL ||
  `http://octogee-gitea-http.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:3000`;

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
  org: string,
  path: string,
  method: string,
  body: unknown | undefined,
  allow404: boolean,
  sudo?: string,
): Promise<unknown | null> {
  // Defense at the impersonation sink: the Sudo header carries a privileged identity,
  // so reject anything that isn't a clean Gitea username (no CRLF/space → no header
  // injection), regardless of how callers derived it.
  if (sudo !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sudo)) {
    throw new Error(`Refusing Gitea Sudo with unsafe identity: ${JSON.stringify(sudo)}`);
  }
  const url = `${GITEA_URL}/api/v1/repos/${org}/${path}`;
  assertGiteaUrl(url);
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      ...(sudo ? { Sudo: sudo } : {}),
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
  if (resp.status === 204 || resp.status === 304) return null;
  return resp.json();
}

export async function giteaApi(org: string, path: string, method = "GET", body?: unknown): Promise<unknown> {
  return giteaFetch(getToken(), org, path, method, body, false) as Promise<unknown>;
}

export async function giteaApiAs(token: string, org: string, path: string, method = "GET", body?: unknown): Promise<unknown> {
  return giteaFetch(token, org, path, method, body, false) as Promise<unknown>;
}

async function giteaApiAllowNotFound(org: string, path: string, method = "GET", body?: unknown): Promise<unknown | null> {
  return giteaFetch(getToken(), org, path, method, body, true);
}

export async function giteaApiAsAllowNotFound(token: string, org: string, path: string, method = "GET", body?: unknown): Promise<unknown | null> {
  return giteaFetch(token, org, path, method, body, true);
}

// First-party impersonation: act on Gitea AS the workspace user via the platform
// admin token + Sudo header — Gitea enforces the impersonated user's repo ACL
// (validated live, PLATFORM-CREDENTIAL-BROKERING-SPEC §Tier 1). Replaces the
// per-user PAT: nothing to mint, store, or rotate. `sudoUser` is the gitea
// username, e.g. `ws-${slug}`.
export async function giteaApiAsUser(
  sudoUser: string,
  org: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  return giteaFetch(getToken(), org, path, method, body, false, sudoUser) as Promise<unknown>;
}

export async function giteaApiAsUserAllowNotFound(
  sudoUser: string,
  org: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown | null> {
  return giteaFetch(getToken(), org, path, method, body, true, sudoUser);
}

export async function giteaDeleteRepo(org: string, repo: string): Promise<void> {
  await giteaApiAllowNotFound(org, encodeURIComponent(repo), "DELETE");
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
  org: string,
  repoName: string,
  description: string,
  privateRepo: boolean,
): Promise<void> {
  const url = `${GITEA_URL}/api/v1/orgs/${org}/repos`;
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
  org: string,
  repoName: string,
  filePath: string,
  content: string,
  commitMessage: string,
): Promise<void> {
  const url = `${GITEA_URL}/api/v1/repos/${org}/${repoName}/contents/${filePath}`;
  const existing = await giteaAdminFetch("GET", url, undefined, true);
  if (existing !== null) return;
  await giteaAdminFetch("POST", url, {
    message: commitMessage,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch: "main",
  }, false);
}
