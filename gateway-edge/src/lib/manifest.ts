import { giteaApiAsUser, giteaApiAsUserAllowNotFound } from "./gitea.js";
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
  sudoUser: string,
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
    const resp = (await giteaApiAsUser(
      sudoUser,
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

async function fetchRawManifest(sudoUser: string, org: string, repoName: string): Promise<RawManifest> {
  try {
    const existing = (await giteaApiAsUser(
      sudoUser,
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
  sudoUser: string,
  org: string,
  repoName: string,
): Promise<RawManifest | null> {
  const existing = (await giteaApiAsUserAllowNotFound(
    sudoUser,
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

export async function getManifestForQuota(
  sudoUser: string,
  org: string,
  repoName: string,
): Promise<Manifest> {
  const raw = await fetchRawManifestAllowNotFound(sudoUser, org, repoName);
  if (!raw) return {};
  for (const [path, value] of Object.entries(raw.manifest)) {
    const entry = value as Partial<ManifestEntry> | null;
    if (
      !entry ||
      entry.type !== "blob" ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size !== Math.abs(entry.size)
    ) {
      throw new Error(`invalid blob manifest entry at ${path}`);
    }
  }
  return raw.manifest as Manifest;
}

export async function updateManifest(
  sudoUser: string,
  org: string,
  repoName: string,
  entries: Record<string, unknown>,
): Promise<void> {
  const { manifest, sha } = await fetchRawManifest(sudoUser, org, repoName);
  Object.assign(manifest, entries);
  const content = Buffer.from(JSON.stringify(manifest, null, 2)).toString("base64");
  await giteaApiAsUser(sudoUser, org, `${repoName}/contents/${MANIFEST_PATH}`, "PUT", {
    message: `blob: update manifest`,
    content,
    ...(sha ? { sha } : {}),
  });
  manifestCache.delete(cacheKey(org, repoName));
}

export async function removeFromManifest(
  sudoUser: string,
  org: string,
  repoName: string,
  paths: string | string[],
  commitMessage?: string,
): Promise<void> {
  const toRemove = Array.isArray(paths) ? paths : [paths];
  try {
    const raw = await fetchRawManifestAllowNotFound(sudoUser, org, repoName);
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
    await giteaApiAsUser(sudoUser, org, `${repoName}/contents/${MANIFEST_PATH}`, "PUT", {
      message: commitMessage ?? `blob: remove ${toRemove.join(", ")}`,
      content,
      sha: raw.sha,
    });
    manifestCache.delete(cacheKey(org, repoName));
  } catch (e: unknown) {
    logger.warn(`Manifest removal failed for ${repoName}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
