import { internalFetch } from "./internal-fetch.js";

// In-pod provisioner → octogee-api broker for Gitea ADMIN operations.
// The provisioner runs in the OpenClaw gateway container and holds NO Gitea admin
// token (GIT_API_TOKEN dropped, PLATFORM-CREDENTIAL-BROKERING). It calls octogee-api,
// which holds GITEA_TOKEN, through internalFetch. internalFetch attaches the projected
// gateway KSA token from disk; no shared INTERNAL_SERVICE_KEY is required in the gateway.
// Every call fails loud on a non-2xx response —
// the reconcile loop retries; nothing is swallowed.

function baseUrl(): string {
  if (process.env.GITEA_ADMIN_BROKER_URL) return process.env.GITEA_ADMIN_BROKER_URL;
  return process.env.GATEWAY_EDGE_INTERNAL_URL || "http://127.0.0.1:3001";
}

async function postVoid(path: string, body: unknown): Promise<void> {
  const resp = await internalFetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 300);
    throw new Error(`gitea-broker POST ${path} → ${resp.status} ${text}`);
  }
}

async function getJson(path: string): Promise<unknown> {
  const resp = await internalFetch(`${baseUrl()}${path}`, { method: "GET" });
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 300);
    throw new Error(`gitea-broker GET ${path} → ${resp.status} ${text}`);
  }
  return resp.json();
}

export async function ensureGiteaUser(slug: string, pubKey: string): Promise<void> {
  await postVoid("/internal/gitea/ensure-user", { slug, pubKey });
}

export async function releaseGiteaUserKey(slug: string, pubKey: string): Promise<void> {
  await postVoid("/internal/gitea/release-user-key", { slug, pubKey });
}

export async function readGiteaUserPubKeys(slug: string): Promise<string[]> {
  const data = (await getJson(
    `/internal/gitea/user-pubkeys?slug=${encodeURIComponent(slug)}`,
  )) as { pubKeys: string[] };
  return data.pubKeys;
}

export async function ensureGiteaOrgForWorkspace(slug: string): Promise<void> {
  await postVoid("/internal/gitea/ensure-org", { slug });
}

export async function ensureWorkspaceRepo(slug: string): Promise<void> {
  await postVoid("/internal/gitea/ensure-workspace-repo", { slug });
}

export async function ensureSystemConfigRepo(slug: string): Promise<void> {
  await postVoid("/internal/gitea/ensure-system-config-repo", { slug });
}

export async function ensureProjectCoachRepo(slug: string): Promise<void> {
  await postVoid("/internal/gitea/ensure-project-coach-repo", { slug });
}

export async function ensureProjectRepo(slug: string, projectName: string): Promise<void> {
  await postVoid("/internal/gitea/ensure-project-repo", { slug, projectName });
}

export async function repoExists(org: string, repo: string): Promise<boolean> {
  const data = (await getJson(
    `/internal/gitea/repo-exists?org=${encodeURIComponent(org)}&repo=${encodeURIComponent(repo)}`,
  )) as { exists: boolean };
  return data.exists;
}

export async function archiveRepo(org: string, repo: string): Promise<void> {
  await postVoid("/internal/gitea/archive-repo", { org, repo });
}
