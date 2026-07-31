import { catalogEntryForModelRef } from "./agent-models.js";
import {
  BUILDER_TIERS,
  TIERS,
  type BuilderTierName,
  type PersonalTierName,
} from "./billing-tiers.js";
import type { ModelCatalogProvider } from "./model-catalog.js";

// Operator dials for platform-wide model policy, stored at platformConfig/models
// (server-only collection; admin reads/writes go through the API). Absent or
// invalid doc → the compiled default below, so the free tier always has a
// resolvable house pin.

export const PLATFORM_CONFIG_COLLECTION = "platformConfig";
export const PLATFORM_MODEL_CONFIG_DOC = "models";
export const PLATFORM_CONNECT_CONFIG_DOC = "connect";
export const PLATFORM_FREE_CONFIG_DOC = "free";
export const PLATFORM_TRIAL_CONFIG_DOC = "trial";

export const TRIAL_CONFIG_SCHEMA_VERSION = 2 as const;

export interface PlatformFreeConfig {
  schemaVersion: 1;
  workspaceStorageGb: number;
  updatedAt?: unknown;
  updatedBy?: string;
}

export const DEFAULT_PLATFORM_FREE_CONFIG: PlatformFreeConfig = {
  schemaVersion: 1,
  workspaceStorageGb: 10,
};

export function parsePlatformFreeConfig(value: unknown): PlatformFreeConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.workspaceStorageGb !== "number" ||
    !Number.isFinite(raw.workspaceStorageGb) ||
    raw.workspaceStorageGb <= 0 ||
    raw.workspaceStorageGb > 1000 ||
    (raw.updatedBy !== undefined && typeof raw.updatedBy !== "string")
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    workspaceStorageGb: raw.workspaceStorageGb,
    ...(raw.updatedAt !== undefined ? { updatedAt: raw.updatedAt } : {}),
    ...(raw.updatedBy !== undefined ? { updatedBy: raw.updatedBy } : {}),
  };
}

export type TrialBuilderTier = Exclude<BuilderTierName, "enterprise">;

export interface PlatformTrialConfig {
  schemaVersion: typeof TRIAL_CONFIG_SCHEMA_VERSION;
  offerId: string;
  offerVersion: number;
  durationDays: number;
  defaultPersonalTier: PersonalTierName;
  defaultBuilderTier: TrialBuilderTier;
  updatedAt?: unknown;
  updatedBy?: string;
}

export const DEFAULT_PLATFORM_TRIAL_CONFIG: PlatformTrialConfig = {
  schemaVersion: TRIAL_CONFIG_SCHEMA_VERSION,
  offerId: "builder-signup",
  offerVersion: 1,
  durationDays: 7,
  defaultPersonalTier: "personal",
  defaultBuilderTier: "hobby",
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

function validTrialOfferIdentity(raw: Record<string, unknown>): boolean {
  return raw.schemaVersion === TRIAL_CONFIG_SCHEMA_VERSION &&
    typeof raw.offerId === "string" &&
    raw.offerId.trim().length > 0 &&
    Number.isInteger(raw.offerVersion) &&
    (raw.offerVersion as number) >= 1;
}

function validTrialOfferTerms(raw: Record<string, unknown>): boolean {
  return Number.isInteger(raw.durationDays) &&
    (raw.durationDays as number) >= 1 &&
    (raw.durationDays as number) <= 30 &&
    isPersonalTier(raw.defaultPersonalTier) &&
    isTrialBuilderTier(raw.defaultBuilderTier);
}

function validConfigEditor(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function parsePlatformTrialConfig(value: unknown): PlatformTrialConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    !validTrialOfferIdentity(raw) ||
    !validTrialOfferTerms(raw) ||
    !validConfigEditor(raw.updatedBy)
  ) {
    return null;
  }
  return {
    schemaVersion: TRIAL_CONFIG_SCHEMA_VERSION,
    offerId: raw.offerId as string,
    offerVersion: raw.offerVersion as number,
    durationDays: raw.durationDays as number,
    defaultPersonalTier: raw.defaultPersonalTier as PersonalTierName,
    defaultBuilderTier: raw.defaultBuilderTier as TrialBuilderTier,
    ...(raw.updatedAt !== undefined ? { updatedAt: raw.updatedAt } : {}),
    ...(raw.updatedBy !== undefined ? { updatedBy: raw.updatedBy as string } : {}),
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
    offerId: config.offerId,
    offerVersion: config.offerVersion,
    durationDays: config.durationDays,
    defaultPersonalTier: config.defaultPersonalTier,
    defaultBuilderTier: config.defaultBuilderTier,
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
export const DEFAULT_OPS_AGENT_MODEL_REF = "platform-openrouter/minimax/minimax-m3";

// The platform default every Builder's Agent starts on until they pick their
// own model in Account → Models. Fallback ref null = no fallback.
export const DEFAULT_BUILDER_AGENT_MODEL_REF = "platform-openrouter/openai/gpt-5.6-luna";
export const DEFAULT_BUILDER_AGENT_FALLBACK_MODEL_REF: string | null =
  "platform-openrouter/z-ai/glm-5.2";

export interface BuilderAgentModelDefault {
  primary: string;
  fallbacks: string[];
}

export interface PlatformModelConfig {
  freeTierModelRef: string;
  opsAgentModelRef: string;
  builderAgentModelRef: string;
  builderAgentFallbackModelRef: string | null;
}

export interface ResolvedFreeTierModel {
  ref: string;
  provider: ModelCatalogProvider;
  upstreamModelId: string;
}

export interface ResolvedOpsAgentModel extends ResolvedFreeTierModel {
  runtimeModelRef: string;
}

function catalogRefOrNull(value: unknown): string | null {
  return typeof value === "string" && resolveFreeTierModel(value) !== null ? value : null;
}

export function parsePlatformModelConfig(value: unknown): PlatformModelConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const config = value as {
    freeTierModelRef?: unknown;
    opsAgentModelRef?: unknown;
    builderAgentModelRef?: unknown;
    builderAgentFallbackModelRef?: unknown;
  };
  const freeTierModelRef = catalogRefOrNull(config.freeTierModelRef);
  if (freeTierModelRef === null) return null;
  const opsAgentModelRef = config.opsAgentModelRef ?? DEFAULT_OPS_AGENT_MODEL_REF;
  if (typeof opsAgentModelRef !== "string" || resolveOpsAgentModel(opsAgentModelRef) === null) {
    return null;
  }
  const builderAgentModelRef = catalogRefOrNull(
    config.builderAgentModelRef ?? DEFAULT_BUILDER_AGENT_MODEL_REF,
  );
  if (builderAgentModelRef === null) return null;
  const fallbackInput =
    config.builderAgentFallbackModelRef === undefined
      ? DEFAULT_BUILDER_AGENT_FALLBACK_MODEL_REF
      : config.builderAgentFallbackModelRef;
  const builderAgentFallbackModelRef = fallbackInput === null ? null : catalogRefOrNull(fallbackInput);
  if (fallbackInput !== null && builderAgentFallbackModelRef === null) return null;
  return {
    freeTierModelRef,
    opsAgentModelRef,
    builderAgentModelRef,
    builderAgentFallbackModelRef,
  };
}

// The {primary, fallbacks} selection every Builder Agent inherits, from the
// stored platformConfig/models doc. Field-tolerant: an absent or invalid ref
// falls back to the compiled default so a bad doc can never blank the fleet.
export function builderAgentModelDefaultFromDoc(data: unknown): BuilderAgentModelDefault {
  const raw = (data ?? {}) as {
    builderAgentModelRef?: unknown;
    builderAgentFallbackModelRef?: unknown;
  };
  const primary = catalogRefOrNull(raw.builderAgentModelRef) ?? DEFAULT_BUILDER_AGENT_MODEL_REF;
  const fallbackRef = raw.builderAgentFallbackModelRef === null
    ? null
    : catalogRefOrNull(raw.builderAgentFallbackModelRef) ?? DEFAULT_BUILDER_AGENT_FALLBACK_MODEL_REF;
  return {
    primary,
    fallbacks: fallbackRef !== null && fallbackRef !== primary ? [fallbackRef] : [],
  };
}

// Strict payload validation for the untrusted side of the sync wire: the pod
// applies the default only when the trusted stamp arrives whole and every ref
// resolves in the catalog; anything else means "leave the config default".
export function parseBuilderAgentModelDefault(value: unknown): BuilderAgentModelDefault | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as { primary?: unknown; fallbacks?: unknown };
  if (typeof raw.primary !== "string" || resolveFreeTierModel(raw.primary) === null) return null;
  if (!Array.isArray(raw.fallbacks)) return null;
  const fallbacks: string[] = [];
  for (const ref of raw.fallbacks) {
    if (typeof ref !== "string" || resolveFreeTierModel(ref) === null) return null;
    fallbacks.push(ref);
  }
  return { primary: raw.primary, fallbacks };
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
