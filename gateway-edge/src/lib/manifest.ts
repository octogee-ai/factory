import {
  createGcsManifestStore,
  putManifestEntries,
  readManifest,
  removeManifestEntries,
  type Manifest,
  type ManifestEntry,
  type ManifestStore,
} from "@octogee/core/workspace-manifest";

import { logger } from "../middleware/logging.js";
import { storage } from "./db.js";

export type { Manifest, ManifestEntry };

const MANIFEST_TTL_MS = 60_000;

interface CacheEntry {
  data: Manifest;
  ts: number;
}

const manifestCache = new Map<string, CacheEntry>();

function store(): ManifestStore {
  return createGcsManifestStore(storage.bucket());
}

export async function getManifest(gcsPrefix: string, bustCache = false): Promise<Manifest> {
  if (!bustCache) {
    const cached = manifestCache.get(gcsPrefix);
    if (cached && Date.now() - cached.ts < MANIFEST_TTL_MS) return cached.data;
  }
  let data: Manifest;
  try {
    data = await readManifest(store(), gcsPrefix);
  } catch (err) {
    logger.error("blob manifest unreadable; listing blobs as empty", { err, gcsPrefix });
    return {};
  }
  manifestCache.set(gcsPrefix, { data, ts: Date.now() });
  return data;
}

export async function getManifestForQuota(gcsPrefix: string): Promise<Manifest> {
  return readManifest(store(), gcsPrefix);
}

export async function updateManifest(gcsPrefix: string, entries: Manifest): Promise<void> {
  await putManifestEntries(store(), gcsPrefix, entries);
  manifestCache.delete(gcsPrefix);
}

export async function removeFromManifest(
  gcsPrefix: string,
  paths: string | string[],
): Promise<void> {
  await removeManifestEntries(store(), gcsPrefix, paths);
  manifestCache.delete(gcsPrefix);
}

export function invalidateManifestCache(gcsPrefix: string): void {
  manifestCache.delete(gcsPrefix);
}
