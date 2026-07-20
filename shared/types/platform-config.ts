import { catalogEntryForModelRef } from "./agent-models.js";
import {
  BUILDER_TIERS,
  TIERS,
  type BuilderTierName,
  type PersonalTierName,
} from "./billing-tiers.js";
import { isBareGatewayId } from "./gateway-mutable-config.js";
import type { ModelCatalogProvider } from "./model-catalog.js";

// Operator dials for platform-wide model policy, stored at platformConfig/models
// (server-only collection; admin reads/writes go through the API). Absent or
// invalid doc → the compiled default below, so the free tier always has a
// resolvable house pin.

export const PLATFORM_CONFIG_COLLECTION = "platformConfig";
export const PLATFORM_MODEL_CONFIG_DOC = "models";
export const PLATFORM_CONNECT_CONFIG_DOC = "connect";
export const PLATFORM_TRIAL_CONFIG_DOC = "trial";

export const TRIAL_CONFIG_SCHEMA_VERSION = 1 as const;

export type TrialBuilderTier = Exclude<BuilderTierName, "enterprise">;

export interface PlatformTrialConfig {
  schemaVersion: typeof TRIAL_CONFIG_SCHEMA_VERSION;
  defaultPersonalTier: PersonalTierName;
  defaultBuilderTier: TrialBuilderTier;
  releaseSourceGatewayId: string;
  updatedAt?: unknown;
  updatedBy?: string;
}

export const DEFAULT_PLATFORM_TRIAL_CONFIG: PlatformTrialConfig = {
  schemaVersion: TRIAL_CONFIG_SCHEMA_VERSION,
  defaultPersonalTier: "personal_pro",
  defaultBuilderTier: "pro",
  releaseSourceGatewayId: "default",
};

function isPersonalTier(value: unknown): value is PersonalTierName {
  return typeof value === "string" && value in TIERS && value !== "builder" && value !== "operator";
}

function isTrialBuilderTier(value: unknown): value is TrialBuilderTier {
  return (
    typeof value === "string" &&
    value in BUILDER_TIERS &&
    BUILDER_TIERS[value as BuilderTierName].instance !== null
  );
}

export function parsePlatformTrialConfig(value: unknown): PlatformTrialConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.schemaVersion !== TRIAL_CONFIG_SCHEMA_VERSION ||
    !isPersonalTier(raw.defaultPersonalTier) ||
    !isTrialBuilderTier(raw.defaultBuilderTier) ||
    !isBareGatewayId(raw.releaseSourceGatewayId) ||
    (raw.updatedBy !== undefined && typeof raw.updatedBy !== "string")
  ) {
    return null;
  }
  return {
    schemaVersion: TRIAL_CONFIG_SCHEMA_VERSION,
    defaultPersonalTier: raw.defaultPersonalTier,
    defaultBuilderTier: raw.defaultBuilderTier,
    releaseSourceGatewayId: raw.releaseSourceGatewayId,
    ...(raw.updatedAt !== undefined ? { updatedAt: raw.updatedAt } : {}),
    ...(raw.updatedBy !== undefined ? { updatedBy: raw.updatedBy } : {}),
  };
}

function fnv1a64Hex(input: string): string {
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    high = Math.imul(high ^ code, 0x01000193) >>> 0;
    low = Math.imul(low ^ code, 0x811c9dc5) >>> 0;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

export function trialConfigHash(config: PlatformTrialConfig): string {
  return fnv1a64Hex(JSON.stringify({
    schemaVersion: config.schemaVersion,
    defaultPersonalTier: config.defaultPersonalTier,
    defaultBuilderTier: config.defaultBuilderTier,
    releaseSourceGatewayId: config.releaseSourceGatewayId,
  }));
}

export type GoogleConnectStage = "off" | "allowlist" | "on";

export interface PlatformConnectConfig {
  googleStage: GoogleConnectStage;
  googleAllowlistUids: string[];
}

export const DEFAULT_PLATFORM_CONNECT_CONFIG: PlatformConnectConfig = {
  googleStage: "off",
  googleAllowlistUids: [],
};

export function parsePlatformConnectConfig(value: unknown): PlatformConnectConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { googleStage, googleAllowlistUids } = value as {
    googleStage?: unknown;
    googleAllowlistUids?: unknown;
  };
  if (googleStage !== "off" && googleStage !== "allowlist" && googleStage !== "on") return null;
  if (googleAllowlistUids !== undefined) {
    if (!Array.isArray(googleAllowlistUids)) return null;
    if (googleAllowlistUids.some((uid) => typeof uid !== "string")) return null;
  }
  const uids = ((googleAllowlistUids ?? []) as string[])
    .map((uid) => uid.trim())
    .filter((uid) => uid.length > 0);
  return { googleStage, googleAllowlistUids: uids };
}

export function googleConnectAllowed(
  config: PlatformConnectConfig | null,
  uid: string,
): boolean {
  if (!config || uid.length === 0) return false;
  if (config.googleStage === "on") return true;
  if (config.googleStage === "allowlist") return config.googleAllowlistUids.includes(uid);
  return false;
}

// The free-tier house model: DeepSeek V4 Pro on the OpenRouter platform key
// (operator default 2026-07-08; the dial can point anywhere in the catalog).
export const DEFAULT_FREE_TIER_MODEL_REF = "platform-openrouter/deepseek/deepseek-v4-pro";
export const DEFAULT_OPS_AGENT_MODEL_REF = "platform-openrouter/z-ai/glm-5.2";

export interface PlatformModelConfig {
  freeTierModelRef: string;
  opsAgentModelRef: string;
}

export interface ResolvedFreeTierModel {
  ref: string;
  provider: ModelCatalogProvider;
  upstreamModelId: string;
}

export interface ResolvedOpsAgentModel extends ResolvedFreeTierModel {
  runtimeModelRef: string;
}

export function parsePlatformModelConfig(value: unknown): PlatformModelConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const config = value as { freeTierModelRef?: unknown; opsAgentModelRef?: unknown };
  if (
    typeof config.freeTierModelRef !== "string" ||
    resolveFreeTierModel(config.freeTierModelRef) === null
  ) {
    return null;
  }
  const opsAgentModelRef = config.opsAgentModelRef ?? DEFAULT_OPS_AGENT_MODEL_REF;
  if (typeof opsAgentModelRef !== "string" || resolveOpsAgentModel(opsAgentModelRef) === null) {
    return null;
  }
  return { freeTierModelRef: config.freeTierModelRef, opsAgentModelRef };
}

// Split a catalog model ref into what each dial consumer needs: the broker
// provider profile the traffic rides, and the model id the upstream API
// accepts (anthropic entries are catalog-prefixed; the wire wants the bare id).
export function resolveFreeTierModel(ref: string): ResolvedFreeTierModel | null {
  const entry = catalogEntryForModelRef(ref);
  if (!entry) return null;
  return {
    ref,
    provider: entry.provider,
    upstreamModelId:
      entry.provider === "anthropic" ? entry.id.replace(/^anthropic\//, "") : entry.id,
  };
}

export function resolveOpsAgentModel(ref: string): ResolvedOpsAgentModel | null {
  const resolved = resolveFreeTierModel(ref);
  if (!resolved || resolved.provider !== "openrouter") return null;
  return {
    ...resolved,
    runtimeModelRef: `openrouter/${resolved.upstreamModelId}`,
  };
}
