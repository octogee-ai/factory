import type { PlatformConfigRepository } from "@octogee/core/platform-state";
import {
  DEFAULT_FREE_TIER_MODEL_REF,
  DEFAULT_OPS_AGENT_MODEL_REF,
  builderAgentModelDefaultFromDoc,
  resolveFreeTierModel,
  resolveOpsAgentModel,
  type BuilderAgentModelDefault,
  type ResolvedFreeTierModel,
  type ResolvedOpsAgentModel,
} from "@octogee/shared/types/platform-config";

const DEFAULT_TTL_MS = 60_000;

export type FreeTierModelResolver = () => Promise<ResolvedFreeTierModel>;
export type OpsAgentModelResolver = () => Promise<ResolvedOpsAgentModel>;
export type BuilderAgentDefaultResolver = () => Promise<BuilderAgentModelDefault>;

function mustResolve(ref: string): ResolvedFreeTierModel {
  const resolved = resolveFreeTierModel(ref);
  if (!resolved) {
    throw new Error(`compiled default free-tier model ref is not in the catalog: ${ref}`);
  }
  return resolved;
}

function mustResolveOpsAgent(ref: string): ResolvedOpsAgentModel {
  const resolved = resolveOpsAgentModel(ref);
  if (!resolved) {
    throw new Error(`compiled default Ops Agent model ref is not an OpenRouter catalog model: ${ref}`);
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
export function createCachedBuilderAgentDefaultResolver(opts: {
  platformConfig: Pick<PlatformConfigRepository, "get">;
  ttlMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}): BuilderAgentDefaultResolver {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const fallback = builderAgentModelDefaultFromDoc(undefined);
  let cached: { value: BuilderAgentModelDefault; resolvedAt: number } | null = null;

  return async () => {
    const at = now();
    if (cached && at - cached.resolvedAt < ttlMs) return cached.value;
    try {
      const value = builderAgentModelDefaultFromDoc((await opts.platformConfig.get("models"))?.value);
      cached = { value, resolvedAt: at };
      return value;
    } catch (err) {
      opts.onError?.(err);
      return cached?.value ?? fallback;
    }
  };
}

export function createCachedOpsAgentModelResolver(opts: {
  platformConfig: Pick<PlatformConfigRepository, "get">;
  ttlMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}): OpsAgentModelResolver {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const fallback = mustResolveOpsAgent(DEFAULT_OPS_AGENT_MODEL_REF);
  let cached: { value: ResolvedOpsAgentModel; resolvedAt: number } | null = null;

  return async () => {
    const at = now();
    if (cached && at - cached.resolvedAt < ttlMs) return cached.value;
    try {
      const models = (await opts.platformConfig.get("models"))?.value;
      let value = fallback;
      if (models !== undefined) {
        if (resolveOpsAgentModel(models.opsAgentModelRef)) {
          value = mustResolveOpsAgent(models.opsAgentModelRef);
        } else {
          opts.onError?.(
            new Error(
              `platformConfig/models opsAgentModelRef is not an OpenRouter catalog ref: ${JSON.stringify(
                models.opsAgentModelRef,
              )} — serving ${DEFAULT_OPS_AGENT_MODEL_REF}`,
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
