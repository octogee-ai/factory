import type { PlatformConfigRepository } from "@octogee/core/platform-state";
import {
  DEFAULT_FREE_TIER_MODEL_REF,
  userAgentModelDefaultFromDoc,
  resolveFreeTierModel,
  type UserAgentModelDefault,
  type ResolvedFreeTierModel,
} from "@octogee/shared/types/platform-config";

const DEFAULT_TTL_MS = 60_000;

export type FreeTierModelResolver = () => Promise<ResolvedFreeTierModel>;
export type UserAgentDefaultResolver = () => Promise<UserAgentModelDefault>;

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
  platformConfig: Pick<PlatformConfigRepository, "get">;
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
      const models = (await opts.platformConfig.get("models"))?.value;
      let value = fallback;
      if (models !== undefined) {
        if (resolveFreeTierModel(models.freeTierModelRef)) {
          value = mustResolve(models.freeTierModelRef);
        } else {
          opts.onError?.(
            new Error(
              `platformConfig/models freeTierModelRef is not a catalog ref: ${JSON.stringify(
                models.freeTierModelRef,
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

// Same contract as the free-tier resolver: the field-tolerant doc read means
// an unreadable or invalid doc serves the last-known (else compiled) default.
export function createCachedUserAgentDefaultResolver(opts: {
  platformConfig: Pick<PlatformConfigRepository, "get">;
  ttlMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}): UserAgentDefaultResolver {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const fallback = userAgentModelDefaultFromDoc(undefined);
  let cached: { value: UserAgentModelDefault; resolvedAt: number } | null = null;

  return async () => {
    const at = now();
    if (cached && at - cached.resolvedAt < ttlMs) return cached.value;
    try {
      const value = userAgentModelDefaultFromDoc((await opts.platformConfig.get("models"))?.value);
      cached = { value, resolvedAt: at };
      return value;
    } catch (err) {
      opts.onError?.(err);
      return cached?.value ?? fallback;
    }
  };
}
