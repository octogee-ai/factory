import { GoogleAuth } from "google-auth-library";
import { IMAGE_TAG_PATTERN } from "./image-tag.js";

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
  const project = opts.project ?? process.env.GCP_PROJECT ?? "octogee";
  const location = opts.location ?? process.env.GAR_LOCATION ?? "us-central1";
  const repository = opts.repository ?? process.env.GAR_REPO ?? "octogee";
  const limit = opts.limit ?? DEFAULT_LIMIT;
  // Read enough deduped builds to absorb multi-arch dupes + a buffer; once
  // the accumulator passes this, further pages can only push older builds.
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
