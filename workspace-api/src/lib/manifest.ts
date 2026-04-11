/**
 * Blob manifest helpers for workspace/project repos.
 *
 * Every customer repo stores a `.files/manifest.json` that maps logical
 * file paths to GCS blob descriptors (size, mimeType, gcsPath, optional
 * thumbnail). This module owns the read / merge / remove lifecycle so
 * every file-ops route can just call `getManifest`, `updateManifest`, or
 * `removeFromManifest` without re-rolling base64 decode/encode, sha
 * bookkeeping, or cache invalidation.
 *
 * Cache policy: a 60-second in-process TTL for reads. Writes go straight
 * to Gitea and do NOT populate the read cache — the next read after a
 * write will re-fetch, so stale writes are at most one TTL window behind.
 * Pass `bustCache: true` to force a fresh read (used by routes that
 * deliberately want to see their own write).
 *
 * This module is deliberately I/O-only; the validation + auth layer lives
 * in `routes/workspace.ts` + `lib/fileTarget.ts`.
 */
import { giteaApiAs, giteaApiAsAllowNotFound } from "./gitea";
import { logger } from "../middleware/logging";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ManifestEntry {
  type: "blob";
  gcsPath: string;
  size: number;
  mimeType: string;
  thumbnailUrl?: string;
  uploadedAt: string;
}

export type Manifest = Record<string, ManifestEntry>;

// ─── Cache ──────────────────────────────────────────────────────────────────

const MANIFEST_PATH = ".files/manifest.json";
const MANIFEST_TTL_MS = 60_000;

interface CacheEntry {
  data: Manifest;
  ts: number;
}

const manifestCache = new Map<string, CacheEntry>();

/** Test-only: drop the in-process cache. Not called from production code. */
export function __clearManifestCache(): void {
  manifestCache.clear();
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Read the manifest for a repo. Returns `{}` for a 404 or any parse error
 * — the calling route treats "no manifest" as "no blob-kind files", which
 * is indistinguishable from an empty manifest for listing purposes.
 *
 * Pass `bustCache: true` after a write to force a fresh fetch (e.g. the
 * `GET /files` route honors a `?nocache=1` query param).
 */
export async function getManifest(
  token: string,
  repoName: string,
  bustCache = false,
): Promise<Manifest> {
  if (!bustCache) {
    const cached = manifestCache.get(repoName);
    if (cached && Date.now() - cached.ts < MANIFEST_TTL_MS) return cached.data;
  }
  try {
    const resp = (await giteaApiAs(
      token,
      `${repoName}/contents/${MANIFEST_PATH}`,
    )) as { content?: string };
    const decoded = Buffer.from(resp.content ?? "", "base64").toString("utf-8");
    const data: Manifest = JSON.parse(decoded);
    manifestCache.set(repoName, { data, ts: Date.now() });
    return data;
  } catch {
    return {};
  }
}

// ─── Internal raw read (sha + content) ──────────────────────────────────────

interface RawManifest {
  manifest: Record<string, unknown>;
  sha: string | undefined;
}

/**
 * Fetch the manifest along with its current Gitea sha, so the caller can
 * PUT a new version without stomping a concurrent write. Returns an empty
 * manifest + undefined sha when the file doesn't exist yet (new repo).
 *
 * The two flavors below (`fetchRaw` vs `fetchRawAllowNotFound`) differ
 * only in which Gitea helper they use — `updateManifest` is tolerant of
 * "new manifest" errors; `removeFromManifest` uses the explicit
 * `allowNotFound` helper for clarity at the call site.
 */
async function fetchRawManifest(token: string, repoName: string): Promise<RawManifest> {
  try {
    const existing = (await giteaApiAs(
      token,
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
  repoName: string,
): Promise<RawManifest | null> {
  const existing = (await giteaApiAsAllowNotFound(
    token,
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

// ─── Write ──────────────────────────────────────────────────────────────────

/**
 * Shallow-merge the given entries into the manifest and PUT the result.
 * Existing keys are overwritten; untouched keys are preserved.
 *
 * Invalidates the in-process cache for this repo so the next read sees
 * the fresh data.
 */
export async function updateManifest(
  token: string,
  repoName: string,
  entries: Record<string, unknown>,
): Promise<void> {
  const { manifest, sha } = await fetchRawManifest(token, repoName);
  Object.assign(manifest, entries);
  const content = Buffer.from(JSON.stringify(manifest, null, 2)).toString("base64");
  await giteaApiAs(token, `${repoName}/contents/${MANIFEST_PATH}`, "PUT", {
    message: `blob: update manifest`,
    content,
    ...(sha ? { sha } : {}),
  });
  manifestCache.delete(repoName);
}

/**
 * Remove one or more paths from the manifest. No-op when the manifest
 * doesn't exist or the paths were never in it. Errors during the Gitea
 * write are logged and swallowed — callers (delete-blob, extract-zip)
 * treat manifest maintenance as non-critical because the underlying blob
 * has already been deleted/moved.
 *
 * Invalidates the in-process cache for this repo.
 */
export async function removeFromManifest(
  token: string,
  repoName: string,
  paths: string | string[],
  commitMessage?: string,
): Promise<void> {
  const toRemove = Array.isArray(paths) ? paths : [paths];
  try {
    const raw = await fetchRawManifestAllowNotFound(token, repoName);
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
    await giteaApiAs(token, `${repoName}/contents/${MANIFEST_PATH}`, "PUT", {
      message: commitMessage ?? `blob: remove ${toRemove.join(", ")}`,
      content,
      sha: raw.sha,
    });
    manifestCache.delete(repoName);
  } catch (e: any) {
    logger.warn(`Manifest removal failed for ${repoName}: ${e.message}`);
  }
}
