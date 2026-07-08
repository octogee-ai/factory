import type { Firestore } from "firebase-admin/firestore";

import {
  DEFAULT_FREE_TIER_MODEL_REF,
  PLATFORM_CONFIG_COLLECTION,
  PLATFORM_MODEL_CONFIG_DOC,
  parsePlatformModelConfig,
  resolveFreeTierModel,
  type ResolvedFreeTierModel,
} from "@octogee/shared/types/platform-config";

const DEFAULT_TTL_MS = 60_000;

export type FreeTierModelResolver = () => Promise<ResolvedFreeTierModel>;

function mustResolve(ref: string): ResolvedFreeTierModel {
  const resolved = resolveFreeTierModel(ref);
  if (!resolved) {
    throw new Error(`compiled default free-tier model ref is not in the catalog: ${ref}`);
  }
  return resolved;
}

// The broker resolves the free-tier dial live on every degraded call so an
// operator flip lands within one TTL; the cache bounds Firestore reads on the
// hot path. An unreadable or invalid doc never blocks free traffic — it
// reports and serves the last-known (else compiled) house model.
export function createCachedFreeTierModelResolver(opts: {
  db: Pick<Firestore, "collection">;
  ttlMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}): FreeTierModelResolver {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const fallback = mustResolve(DEFAULT_FREE_TIER_MODEL_REF);
  let cached: { value: ResolvedFreeTierModel; resolvedAt: number } | null = null;

  return async () => {
    const at = now();
    if (cached && at - cached.resolvedAt < ttlMs) return cached.value;
    try {
      const snap = await opts.db
        .collection(PLATFORM_CONFIG_COLLECTION)
        .doc(PLATFORM_MODEL_CONFIG_DOC)
        .get();
      const data = snap.data();
      let value = fallback;
      if (data !== undefined) {
        const parsed = parsePlatformModelConfig(data);
        if (parsed) {
          value = mustResolve(parsed.freeTierModelRef);
        } else {
          opts.onError?.(
            new Error(
              `platformConfig/models freeTierModelRef is not a catalog ref: ${JSON.stringify(
                (data as { freeTierModelRef?: unknown }).freeTierModelRef,
              )} — serving ${DEFAULT_FREE_TIER_MODEL_REF}`,
            ),
          );
        }
      }
      cached = { value, resolvedAt: at };
      return value;
    } catch (err) {
      opts.onError?.(err);
      return cached?.value ?? fallback;
    }
  };
}
