import { logger } from "../middleware/logging.js";

export const GITEA_URL =
  process.env.GITEA_URL ||
  `http://octogee-gitea-http.${process.env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:3000`;

const GITEA_HOST = (() => {
  try { return new URL(GITEA_URL).host; } catch { return ""; }
})();

export function assertGiteaUrl(url: string): void {
  let host: string;
  try { host = new URL(url).host; } catch { throw new Error(`Invalid Gitea URL: ${url}`); }
  if (!GITEA_HOST || host !== GITEA_HOST) {
    throw new Error(`Refusing off-Gitea fetch: ${host} !== ${GITEA_HOST}`);
  }
}

export function getToken(): string {
  const token = process.env.GITEA_TOKEN;
  if (!token) throw new Error("GITEA_TOKEN not configured");
  return token;
}

type GiteaFetchOptions = {
  token: string;
  org: string;
  path: string;
  method: string;
  body: unknown | undefined;
  allow404: boolean;
  sudo?: string;
};

async function giteaFetch({
  token,
  org,
  path,
  method,
  body,
  allow404,
  sudo,
}: GiteaFetchOptions): Promise<unknown | null> {
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
  return giteaFetch({ token: getToken(), org, path, method, body, allow404: false }) as Promise<unknown>;
}

export async function giteaApiAs(token: string, org: string, path: string, method = "GET", body?: unknown): Promise<unknown> {
  return giteaFetch({ token, org, path, method, body, allow404: false }) as Promise<unknown>;
}

async function giteaApiAllowNotFound(org: string, path: string, method = "GET", body?: unknown): Promise<unknown | null> {
  return giteaFetch({ token: getToken(), org, path, method, body, allow404: true });
}

export async function giteaApiAsAllowNotFound(token: string, org: string, path: string, method = "GET", body?: unknown): Promise<unknown | null> {
  return giteaFetch({ token, org, path, method, body, allow404: true });
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
  return giteaFetch({
    token: getToken(),
    org,
    path,
    method,
    body,
    allow404: false,
    sudo: sudoUser,
  }) as Promise<unknown>;
}

export async function giteaApiAsUserAllowNotFound(
  sudoUser: string,
  org: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown | null> {
  return giteaFetch({
    token: getToken(),
    org,
    path,
    method,
    body,
    allow404: true,
    sudo: sudoUser,
  });
}

export async function giteaDeleteRepo(org: string, repo: string): Promise<void> {
  await giteaApiAllowNotFound(org, encodeURIComponent(repo), "DELETE");
}

export async function giteaGetRepo(org: string, repo: string): Promise<unknown | null> {
  return giteaApiAllowNotFound(org, encodeURIComponent(repo));
}

export async function giteaDeleteVerifiedRepo(org: string, repo: string): Promise<void> {
  const existing = await giteaGetRepo(org, repo);
  if (existing === null) return;
  assertExpectedRepo(existing, org, repo);

  await giteaDeleteRepo(org, repo);

  const remaining = await giteaGetRepo(org, repo);
  if (remaining !== null) {
    throw new Error(`Gitea repo ${org}/${repo} still exists after deletion`);
  }
}

function assertExpectedRepo(value: unknown, org: string, repo: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Gitea returned an invalid repo for ${org}/${repo}`);
  }
  const record = value as Record<string, unknown>;
  const owner = record.owner;
  const ownerName = owner && typeof owner === "object" && !Array.isArray(owner)
    ? (owner as Record<string, unknown>).login ?? (owner as Record<string, unknown>).username
    : undefined;
  if (record.name !== repo || ownerName !== org) {
    throw new Error(`Gitea repo binding mismatch for ${org}/${repo}`);
  }
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
): Promise<boolean> {
  const url = `${GITEA_URL}/api/v1/orgs/${org}/repos`;
  try {
    await giteaAdminFetch("POST", url, {
      name: repoName,
      description,
      private: privateRepo,
      auto_init: true,
      default_branch: "main",
    }, false);
    return true;
  } catch (err) {
    if ((err as Error & { status?: number })?.status === 409) return false;
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

export async function giteaWriteFiles(
  org: string,
  repoName: string,
  files: ReadonlyArray<{ path: string; content: string }>,
  commitMessage: string,
): Promise<void> {
  const contentsUrl = `${GITEA_URL}/api/v1/repos/${org}/${repoName}/contents`;
  const absent: Array<{ path: string; content: string }> = [];
  for (const file of files) {
    const existing = await giteaAdminFetch("GET", `${contentsUrl}/${file.path}`, undefined, true);
    if (existing === null) absent.push(file);
  }
  if (absent.length === 0) return;
  await giteaCreateFiles(contentsUrl, absent, commitMessage);
}

export async function giteaWriteFilesIfAllAbsent(
  org: string,
  repoName: string,
  files: ReadonlyArray<{ path: string; content: string }>,
  commitMessage: string,
): Promise<void> {
  if (files.length === 0) return;
  const contentsUrl = `${GITEA_URL}/api/v1/repos/${org}/${repoName}/contents`;
  for (const file of files) {
    const existing = await giteaAdminFetch("GET", `${contentsUrl}/${file.path}`, undefined, true);
    if (existing !== null) return;
  }
  await giteaCreateFiles(contentsUrl, files, commitMessage);
}

async function giteaCreateFiles(
  contentsUrl: string,
  files: ReadonlyArray<{ path: string; content: string }>,
  commitMessage: string,
): Promise<void> {
  await giteaAdminFetch("POST", contentsUrl, {
    message: commitMessage,
    branch: "main",
    files: files.map((file) => ({
      operation: "create",
      path: file.path,
      content: Buffer.from(file.content, "utf-8").toString("base64"),
    })),
  }, false);
}
