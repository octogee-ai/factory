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

// Derived once at module load — every fetch in this file checks the final
// URL resolves to this host. Stops server-side request forgery where a
// malicious `path` / `url` argument steers fetch somewhere else (e.g.
// metadata.google.internal). CodeQL js/request-forgery.
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

/** Core fetch — all public functions delegate here. */
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

// ── Admin helpers for project provisioning (phase 5) ────────────────────────
//
// The core `giteaApi` helper hardcodes the `/api/v1/repos/{org}/...`
// prefix, which is fine for repo-scoped operations but can't hit the
// `/orgs/{org}/repos` endpoint needed to CREATE a repo. These two
// helpers bypass the prefix and use the admin token directly.

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

/**
 * Create a project repo under the Octogee org with auto-init so the repo
 * has a default branch we can write to. Idempotent — a 409 "already exists"
 * resolves as success so retry-provisioning flows can call this without
 * pre-checking. See PROJECTS-CANVAS-SPEC §D12.
 */
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
    // 409 = already exists — fine; our target state is "repo exists".
    if ((err as Error & { status?: number })?.status === 409) return;
    throw err;
  }
}

/**
 * PUT a file into the project repo on the default branch. Used to seed
 * README.md at project creation. `content` is UTF-8 text; the Gitea API
 * expects base64, so we encode here.
 *
 * Uses admin credentials because the project repo is freshly created and
 * no per-customer token exists yet at this point in the provisioning flow.
 */
export async function giteaWriteFile(
  repoName: string,
  filePath: string,
  content: string,
  commitMessage: string,
): Promise<void> {
  const url = `${GITEA_URL}/api/v1/repos/${GITEA_ORG}/${repoName}/contents/${filePath}`;
  // Idempotent: if the file already exists (e.g. retry-provisioning), skip.
  const existing = await giteaAdminFetch("GET", url, undefined, true);
  if (existing !== null) return;
  await giteaAdminFetch("POST", url, {
    message: commitMessage,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch: "main",
  }, false);
}
