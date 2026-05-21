import { giteaApiAs, giteaApiAsAllowNotFound } from "./gitea.js";
import { logger } from "../middleware/logging.js";

export interface ManifestEntry {
  type: "blob";
  gcsPath: string;
  size: number;
  mimeType: string;
  thumbnailUrl?: string;
  uploadedAt: string;
}

export type Manifest = Record<string, ManifestEntry>;

const MANIFEST_PATH = ".files/manifest.json";
const MANIFEST_TTL_MS = 60_000;

interface CacheEntry {
  data: Manifest;
  ts: number;
}

const manifestCache = new Map<string, CacheEntry>();

function cacheKey(org: string, repoName: string): string {
  return `${org}/${repoName}`;
}

export async function getManifest(
  token: string,
  org: string,
  repoName: string,
  bustCache = false,
): Promise<Manifest> {
  const key = cacheKey(org, repoName);
  if (!bustCache) {
    const cached = manifestCache.get(key);
    if (cached && Date.now() - cached.ts < MANIFEST_TTL_MS) return cached.data;
  }
  try {
    const resp = (await giteaApiAs(
      token,
      org,
      `${repoName}/contents/${MANIFEST_PATH}`,
    )) as { content?: string };
    const decoded = Buffer.from(resp.content ?? "", "base64").toString("utf-8");
    const data: Manifest = JSON.parse(decoded);
    manifestCache.set(key, { data, ts: Date.now() });
    return data;
  } catch {
    return {};
  }
}

interface RawManifest {
  manifest: Record<string, unknown>;
  sha: string | undefined;
}

async function fetchRawManifest(token: string, org: string, repoName: string): Promise<RawManifest> {
  try {
    const existing = (await giteaApiAs(
      token,
      org,
      `${repoName}/contents/${MANIFEST_PATH}`,
    )) as { sha?: string; content?: string };
    return {
      sha: existing.sha,
      manifest: JSON.parse(
        Buffer.from(existing.content ?? "", "base64").toString("utf-8"),
      ),
    };
  } catch {
    return { sha: undefined, manifest: {} };
  }
}

async function fetchRawManifestAllowNotFound(
  token: string,
  org: string,
  repoName: string,
): Promise<RawManifest | null> {
  const existing = (await giteaApiAsAllowNotFound(
    token,
    org,
    `${repoName}/contents/${MANIFEST_PATH}`,
  )) as { sha?: string; content?: string } | null;
  if (!existing) return null;
  return {
    sha: existing.sha,
    manifest: JSON.parse(
      Buffer.from(existing.content ?? "", "base64").toString("utf-8"),
    ),
  };
}

export async function updateManifest(
  token: string,
  org: string,
  repoName: string,
  entries: Record<string, unknown>,
): Promise<void> {
  const { manifest, sha } = await fetchRawManifest(token, org, repoName);
  Object.assign(manifest, entries);
  const content = Buffer.from(JSON.stringify(manifest, null, 2)).toString("base64");
  await giteaApiAs(token, org, `${repoName}/contents/${MANIFEST_PATH}`, "PUT", {
    message: `blob: update manifest`,
    content,
    ...(sha ? { sha } : {}),
  });
  manifestCache.delete(cacheKey(org, repoName));
}

export async function removeFromManifest(
  token: string,
  org: string,
  repoName: string,
  paths: string | string[],
  commitMessage?: string,
): Promise<void> {
  const toRemove = Array.isArray(paths) ? paths : [paths];
  try {
    const raw = await fetchRawManifestAllowNotFound(token, org, repoName);
    if (!raw) return;
    let changed = false;
    for (const p of toRemove) {
      if (raw.manifest[p] !== undefined) {
        delete raw.manifest[p];
        changed = true;
      }
    }
    if (!changed) return;
    const content = Buffer.from(JSON.stringify(raw.manifest, null, 2)).toString("base64");
    await giteaApiAs(token, org, `${repoName}/contents/${MANIFEST_PATH}`, "PUT", {
      message: commitMessage ?? `blob: remove ${toRemove.join(", ")}`,
      content,
      sha: raw.sha,
    });
    manifestCache.delete(cacheKey(org, repoName));
  } catch (e: any) {
    logger.warn(`Manifest removal failed for ${repoName}: ${e.message}`);
  }
}
