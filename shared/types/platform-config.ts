import { SIMPLE_MODEL_TIERS, catalogEntryForModelRef } from "./agent-models.js";
import type { ModelCatalogProvider } from "./model-catalog.js";

export const DEFAULT_DISPOSABLE_GATEWAY_IDLE_MS = 15 * 60_000;

export interface PlatformRuntimeConfig {
  disposableGatewayIdleMs: number;
}

// Operator dials for platform-wide model policy, stored at platformConfig/models
// (server-only collection; admin reads/writes go through the API). Absent or
// invalid doc → the compiled default below, so the free tier always has a
// resolvable house pin.

export const PLATFORM_CONFIG_COLLECTION = "platformConfig";
export const PLATFORM_MODEL_CONFIG_DOC = "models";
export const PLATFORM_CONNECT_CONFIG_DOC = "connect";
export const PLATFORM_FREE_CONFIG_DOC = "free";

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

export type GoogleConnectStage = "off" | "allowlist" | "on";

export const GOOGLE_CONNECT_STAGES: readonly GoogleConnectStage[] = ["off", "allowlist", "on"];

export const GOOGLE_CONNECT_CAPABILITY_KEYS = [
  "calendar",
  "gmail",
  "drive",
  "drive-full",
  "tasks",
  "contacts",
] as const;

export type GoogleConnectCapabilityKey = (typeof GOOGLE_CONNECT_CAPABILITY_KEYS)[number];

export type GoogleConnectStages = Record<GoogleConnectCapabilityKey, GoogleConnectStage>;

export interface PlatformConnectConfig {
  googleStages: GoogleConnectStages;
  googleAllowlistUids: string[];
}

export const DEFAULT_PLATFORM_CONNECT_CONFIG: PlatformConnectConfig = {
  googleStages: {
    calendar: "off",
    gmail: "off",
    drive: "off",
    "drive-full": "off",
    tasks: "off",
    contacts: "off",
  },
  googleAllowlistUids: [],
};

export function isGoogleConnectCapabilityKey(value: unknown): value is GoogleConnectCapabilityKey {
  return (GOOGLE_CONNECT_CAPABILITY_KEYS as readonly unknown[]).includes(value);
}

function isGoogleConnectStage(value: unknown): value is GoogleConnectStage {
  return (GOOGLE_CONNECT_STAGES as readonly unknown[]).includes(value);
}

export function parseGoogleConnectStages(value: unknown): GoogleConnectStages | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Object.keys(raw).every(isGoogleConnectCapabilityKey)) return null;
  const stages = {} as GoogleConnectStages;
  for (const key of GOOGLE_CONNECT_CAPABILITY_KEYS) {
    const stage = raw[key];
    if (!isGoogleConnectStage(stage)) return null;
    stages[key] = stage;
  }
  return stages;
}

export function parsePlatformConnectConfig(value: unknown): PlatformConnectConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { googleStages, googleAllowlistUids } = value as {
    googleStages?: unknown;
    googleAllowlistUids?: unknown;
  };
  const stages = parseGoogleConnectStages(googleStages);
  if (!stages) return null;
  if (googleAllowlistUids !== undefined) {
    if (!Array.isArray(googleAllowlistUids)) return null;
    if (googleAllowlistUids.some((uid) => typeof uid !== "string")) return null;
  }
  const uids = ((googleAllowlistUids ?? []) as string[])
    .map((uid) => uid.trim())
    .filter((uid) => uid.length > 0);
  return { googleStages: stages, googleAllowlistUids: uids };
}

export function googleCapabilityConnectAllowed(
  config: PlatformConnectConfig | null,
  uid: string,
  capability: GoogleConnectCapabilityKey,
): boolean {
  if (!config || uid.length === 0) return false;
  const stage = config.googleStages[capability];
  if (stage === "on") return true;
  if (stage === "allowlist") return config.googleAllowlistUids.includes(uid);
  return false;
}

export function googleConnectAllowed(config: PlatformConnectConfig | null, uid: string): boolean {
  return GOOGLE_CONNECT_CAPABILITY_KEYS.some((capability) =>
    googleCapabilityConnectAllowed(config, uid, capability),
  );
}

export interface GoogleConsentPermission {
  permitted: GoogleConnectCapabilityKey[];
  excluded: GoogleConnectCapabilityKey[];
}

export function googleConsentPermission(
  config: PlatformConnectConfig | null,
  uid: string,
  requested: readonly GoogleConnectCapabilityKey[],
): GoogleConsentPermission {
  const permitted: GoogleConnectCapabilityKey[] = [];
  const excluded: GoogleConnectCapabilityKey[] = [];
  for (const capability of requested) {
    (googleCapabilityConnectAllowed(config, uid, capability) ? permitted : excluded).push(capability);
  }
  return { permitted, excluded };
}

// The free-tier house model compiles to the Errands tier on the OpenAI platform
// key; the dial can point anywhere in the catalog.
export const DEFAULT_FREE_TIER_MODEL_REF = SIMPLE_MODEL_TIERS.errands.ref;
export const DEFAULT_OPS_AGENT_MODEL_REF = "platform-openrouter/openai/gpt-6-luna";

// The platform default every Builder's Agent starts on until they pick their
// own model in Account → Models: the Everyday tier. Fallback ref null = no fallback.
export const DEFAULT_BUILDER_AGENT_MODEL_REF = SIMPLE_MODEL_TIERS.everyday.ref;
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
      entry.provider === "anthropic" || entry.provider === "vertex"
        ? entry.id.replace(`${entry.provider}/`, "")
        : entry.id,
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
