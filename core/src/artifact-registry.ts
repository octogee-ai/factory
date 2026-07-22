import { GoogleAuth } from "google-auth-library";
import { IMAGE_TAG_PATTERN } from "./image-tag.js";
import { deploymentSettingsForRuntime } from "./deployment-environment.js";

export interface GatewayBuild {
  tag: string;
  pushedAt: string;
  digest: string;
}

interface ListOpts {
  service: string;
  limit?: number;
  project?: string;
  location?: string;
  repository?: string;
}

interface RegistryCoordinates {
  project: string;
  location: string;
  repository: string;
}

function registryCoordinates(overrides: {
  project?: string;
  location?: string;
  repository?: string;
}): RegistryCoordinates {
  if (overrides.project && overrides.location && overrides.repository) {
    return {
      project: overrides.project,
      location: overrides.location,
      repository: overrides.repository,
    };
  }
  const namespace = process.env.K8S_NAMESPACE;
  if (!namespace) {
    throw new Error(
      "K8S_NAMESPACE is required when Artifact Registry coordinates are incomplete",
    );
  }
  const runtime = deploymentSettingsForRuntime({
    namespace,
    targetId: process.env.DEPLOYMENT_TARGET_ID,
  });
  return {
    project: overrides.project ?? runtime.artifactRegistryProjectId,
    location: overrides.location ?? runtime.artifactRegistryLocation,
    repository: overrides.repository ?? runtime.artifactRegistryName,
  };
}

interface DockerImageItem {
  name: string;
  tags?: string[];
  uploadTime?: string;
}

const DEFAULT_LIMIT = 30;
const PAGE_SIZE = 200;

let cachedAuth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!cachedAuth) {
    cachedAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
    });
  }
  return cachedAuth;
}

async function getAccessToken(): Promise<string> {
  const client = await getAuth().getClient();
  const result = await client.getAccessToken();
  const token = typeof result === "string" ? result : result?.token;
  if (!token) throw new Error("artifact-registry: failed to obtain access token");
  return token;
}

function extractBuildsForService(
  items: DockerImageItem[],
  service: string,
): Map<string, GatewayBuild> {
  const servicePrefix = `/dockerImages/${service}@`;
  const seen = new Map<string, GatewayBuild>();
  for (const item of items) {
    if (!item.name.includes(servicePrefix)) continue;
    const digest = item.name.split(servicePrefix)[1];
    if (!digest) continue;
    const pushedAt = item.uploadTime ?? "";
    for (const tag of item.tags ?? []) {
      if (!IMAGE_TAG_PATTERN.test(tag)) continue;
      const existing = seen.get(tag);
      if (!existing || existing.pushedAt < pushedAt) {
        seen.set(tag, { tag, pushedAt, digest });
      }
    }
  }
  return seen;
}

interface DockerImagesPage {
  dockerImages?: DockerImageItem[];
  nextPageToken?: string;
}

const MAX_PAGES = 10;

async function fetchDockerImagesPage(
  project: string,
  location: string,
  repository: string,
  token: string,
  pageToken: string | null,
): Promise<DockerImagesPage> {
  const params = new URLSearchParams({
    pageSize: String(PAGE_SIZE),
    orderBy: "update_time desc",
  });
  if (pageToken) params.set("pageToken", pageToken);
  const url =
    `https://artifactregistry.googleapis.com/v1` +
    `/projects/${project}/locations/${location}/repositories/${repository}/dockerImages` +
    `?${params.toString()}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    const suffix = detail ? ` — ${detail.slice(0, 200)}` : "";
    throw new Error(
      `artifact-registry list failed: ${resp.status} ${resp.statusText}${suffix}`,
    );
  }
  return (await resp.json()) as DockerImagesPage;
}

function mergeNewerBuilds(
  accumulated: Map<string, GatewayBuild>,
  pageMap: Map<string, GatewayBuild>,
): void {
  for (const [tag, build] of pageMap) {
    const existing = accumulated.get(tag);
    if (!existing || existing.pushedAt < build.pushedAt) {
      accumulated.set(tag, build);
    }
  }
}

export async function listGatewayBuilds(opts: ListOpts): Promise<GatewayBuild[]> {
  const { project, location, repository } = registryCoordinates(opts);
  const limit = opts.limit ?? DEFAULT_LIMIT;

const enoughDeduped = limit * 3;

  const token = await getAccessToken();
  const accumulated = new Map<string, GatewayBuild>();
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result: DockerImagesPage = await fetchDockerImagesPage(
      project,
      location,
      repository,
      token,
      pageToken,
    );
    mergeNewerBuilds(
      accumulated,
      extractBuildsForService(result.dockerImages ?? [], opts.service),
    );
    pageToken = result.nextPageToken ?? null;
    if (!pageToken) break;
    if (accumulated.size >= enoughDeduped) break;
  }

  return [...accumulated.values()]
    .sort((a, b) => b.pushedAt.localeCompare(a.pushedAt))
    .slice(0, limit);
}

let cachedWriteAuth: GoogleAuth | null = null;
function getWriteAuth(): GoogleAuth {
  if (!cachedWriteAuth) {
    cachedWriteAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }
  return cachedWriteAuth;
}

async function getWriteToken(): Promise<string> {
  const client = await getWriteAuth().getClient();
  const result = await client.getAccessToken();
  const token = typeof result === "string" ? result : result?.token;
  if (!token) throw new Error("artifact-registry: failed to obtain write access token");
  return token;
}

interface PinCoords {
  project?: string;
  location?: string;
  repository?: string;
}

interface PinOpts extends PinCoords {
  service: string;
  env: string;
  tag: string;
}

function packagesBase(c: PinCoords): string {
  const { project, location, repository } = registryCoordinates(c);
  return (
    `https://artifactregistry.googleapis.com/v1` +
    `/projects/${project}/locations/${location}/repositories/${repository}/packages`
  );
}

function arFetch(url: string, method: string, token: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** Pin the image behind `service:tag` with a `keep-<env>-<tag>` tag so the
 *  cleanup policy retains it while a gateway references it. Idempotent. */
export async function ensureKeepTag(opts: PinOpts): Promise<void> {
  const base = `${packagesBase(opts)}/${opts.service}`;
  const keepTag = `keep-${opts.env}-${opts.tag}`;
  const token = await getWriteToken();
  const getResp = await arFetch(`${base}/tags/${encodeURIComponent(opts.tag)}`, "GET", token);
  if (!getResp.ok) {
    throw new Error(`artifact-registry: cannot resolve ${opts.service}:${opts.tag} (${getResp.status})`);
  }
  const { version } = (await getResp.json()) as { version?: string };
  if (!version) throw new Error(`artifact-registry: ${opts.service}:${opts.tag} has no version`);
  const postResp = await arFetch(
    `${base}/tags?tagId=${encodeURIComponent(keepTag)}`,
    "POST",
    token,
    { version },
  );
  if (!postResp.ok && postResp.status !== 409) {
    const detail = await postResp.text().catch(() => "");
    throw new Error(`artifact-registry: pin ${keepTag} failed: ${postResp.status} ${detail.slice(0, 200)}`);
  }
}

/** Release a `keep-<env>-<tag>` pin (image becomes eligible for the time-based
 *  cleanup once no env still pins it). Idempotent — 404 is already-gone. */
export async function removeKeepTag(opts: PinOpts): Promise<void> {
  const base = `${packagesBase(opts)}/${opts.service}`;
  const keepTag = `keep-${opts.env}-${opts.tag}`;
  const token = await getWriteToken();
  const resp = await arFetch(`${base}/tags/${encodeURIComponent(keepTag)}`, "DELETE", token);
  if (!resp.ok && resp.status !== 404) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`artifact-registry: unpin ${keepTag} failed: ${resp.status} ${detail.slice(0, 200)}`);
  }
}

/** The referenced tags this env currently pins for `service` (keep-<env>- stripped). */
export async function listKeepTags(opts: PinCoords & { service: string; env: string }): Promise<string[]> {
  const base = `${packagesBase(opts)}/${opts.service}`;
  const prefix = `keep-${opts.env}-`;
  const token = await getWriteToken();
  const out: string[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    if (pageToken) params.set("pageToken", pageToken);
    const resp = await arFetch(`${base}/tags?${params.toString()}`, "GET", token);
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`artifact-registry: list tags failed: ${resp.status} ${detail.slice(0, 200)}`);
    }
    const data = (await resp.json()) as { tags?: { name: string }[]; nextPageToken?: string };
    for (const t of data.tags ?? []) {
      const tagId = t.name.split("/tags/")[1];
      if (tagId && tagId.startsWith(prefix)) out.push(tagId.slice(prefix.length));
    }
    pageToken = data.nextPageToken ?? null;
    if (!pageToken) break;
  }
  return out;
}
