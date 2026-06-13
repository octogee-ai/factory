import { internalFetch } from "./internal-fetch.js";

// In-pod provisioner → gateway-edge sidecar broker for Gitea ADMIN operations.
// The provisioner runs in the shell-bearing openclaw container and holds NO Gitea admin
// token (GIT_API_TOKEN dropped, PLATFORM-CREDENTIAL-BROKERING). It calls these localhost
// endpoints on the no-shell gateway-edge sidecar, which holds GITEA_TOKEN. internalFetch
// attaches X-Internal-Service-Key from env. Every call fails loud on a non-2xx response —
// the reconcile loop retries; nothing is swallowed.

function baseUrl(): string {
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

export async function readGiteaUserPubKey(slug: string): Promise<string | null> {
  const data = (await getJson(
    `/internal/gitea/user-pubkey?slug=${encodeURIComponent(slug)}`,
  )) as { pubKey: string | null };
  return data.pubKey;
}

export async function ensureGiteaOrgForWorkspace(slug: string): Promise<void> {
  await postVoid("/internal/gitea/ensure-org", { slug });
}

export async function ensureWorkspaceRepo(slug: string): Promise<void> {
  await postVoid("/internal/gitea/ensure-workspace-repo", { slug });
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
