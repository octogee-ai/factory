import * as path from "node:path";
import * as fs from "node:fs";

import { readAuthProfileStore } from "./auth-profile-sqlite.js";
import { AGENTS_DIR } from "./config.js";
import {
  OpenClawSecretsApplyError,
  applyOpenClawSecretsPlan,
  authProfileApiKeyTarget,
  buildOpenClawSecretsPlan,
  type ApplyOpenClawSecretsPlanOptions,
  type AuthProfileApiKeyTarget,
} from "./openclaw-secrets-apply.js";
import { modelCatalogForProvider } from "@octogee/shared/types/model-catalog";

// The per-agent broker-token anthropic profile for shared (multi-tenant) pods.
// Each customer-agent's anthropic:default resolves to its OWN owner-scoped broker
// token (the secret-resolver fetches it via POST /internal/byok/agent-model-token);
// the broker then resolves platform-or-BYOK per owner. The id is the static
// `agent-model-token-<agentId>` the resolver grammar pins (AGENT_MODEL_TOKEN_ID_RE).
const SECRET_RESOLVER_PROVIDER = "gcp-secret-manager";
const ANTHROPIC_DEFAULT_PROFILE_ID = "anthropic:default";
export const OPENROUTER_BROKER_PROVIDER_ID = "platform-openrouter";
export const OPENROUTER_BROKER_PROFILE_ID = `${OPENROUTER_BROKER_PROVIDER_ID}:default`;
const OPENROUTER_PLATFORM_MARKER = ".platform-openrouter-managed";
export const OPENAI_BROKER_PROVIDER_ID = "platform-openai";
export const OPENAI_BROKER_PROFILE_ID = `${OPENAI_BROKER_PROVIDER_ID}:default`;
const OPENAI_PLATFORM_MARKER = ".platform-openai-managed";

// Only octogee-<slug>-coach agents have a broker-token resolver grammar
// (AGENT_MODEL_TOKEN_ID_RE in secret-resolver.mjs). The boot sweep must skip any
// other agent id rather than write a profile whose keyRef the resolver will refuse
// — fail closed (the agent surfaces a missing-key error) instead of stranding it
// with an unresolvable credential.
const COACH_AGENT_RE = /^octogee-[a-z0-9][a-z0-9-]{0,62}-coach$/;

export interface AnthropicBrokerProfileEntry {
  type: "api_key";
  provider: "anthropic";
  keyRef: { source: "exec"; provider: string; id: string };
}

export interface OpenRouterBrokerProfileEntry {
  type: "api_key";
  provider: typeof OPENROUTER_BROKER_PROVIDER_ID;
  keyRef: { source: "exec"; provider: string; id: string };
}

export type AgentModelBrokerProvider = "anthropic" | "openrouter" | "openai";

export interface OpenRouterBrokerModelInput {
  baseUrl: string;
  model: string;
  contextTokens?: number;
}

export interface OpenRouterBrokerProviderConfigInput extends OpenRouterBrokerModelInput {
  apiKey: string;
}

export interface OpenRouterBrokerProviderConfig {
  api: "openai-completions";
  baseUrl: string;
  apiKey: string;
  models: Array<{ id: string; name: string; contextTokens?: number; contextWindow?: number }>;
}

export interface OpenRouterBrokerModelsJson {
  providers: Record<string, {
    api: "openai-completions";
    baseUrl: string;
    apiKey: string;
    models: Array<{ id: string; name: string; contextTokens?: number; contextWindow?: number }>;
  }>;
}

export function agentModelTokenSecretId(
  agentId: string,
  provider: AgentModelBrokerProvider = "anthropic",
): string {
  if (provider === "anthropic") return `agent-model-token-${agentId}`;
  return `agent-model-token-${provider}-${agentId}`;
}

export function openRouterBrokerProviderConfig(
  input: OpenRouterBrokerProviderConfigInput,
): OpenRouterBrokerProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    models: [
      openRouterBrokerModelConfig(input),
    ],
  };
}

function openRouterBrokerModelConfig(
  input: OpenRouterBrokerModelInput,
): { id: string; name: string; contextTokens?: number; contextWindow?: number } {
  return {
    id: input.model,
    name: input.model,
    ...(typeof input.contextTokens === "number"
      ? { contextTokens: input.contextTokens, contextWindow: input.contextTokens }
      : {}),
  };
}

export function agentModelTokenProfileEntry(agentId: string): AnthropicBrokerProfileEntry {
  return {
    type: "api_key",
    provider: "anthropic",
    keyRef: {
      source: "exec",
      provider: SECRET_RESOLVER_PROVIDER,
      id: agentModelTokenSecretId(agentId, "anthropic"),
    },
  };
}

export function openRouterBrokerProfileEntry(agentId: string): OpenRouterBrokerProfileEntry {
  return {
    type: "api_key",
    provider: OPENROUTER_BROKER_PROVIDER_ID,
    keyRef: {
      source: "exec",
      provider: SECRET_RESOLVER_PROVIDER,
      id: agentModelTokenSecretId(agentId, "openrouter"),
    },
  };
}

export interface OpenAiBrokerProfileEntry {
  type: "api_key";
  provider: typeof OPENAI_BROKER_PROVIDER_ID;
  keyRef: { source: "exec"; provider: string; id: string };
}

export function openAiBrokerProfileEntry(agentId: string): OpenAiBrokerProfileEntry {
  return {
    type: "api_key",
    provider: OPENAI_BROKER_PROVIDER_ID,
    keyRef: {
      source: "exec",
      provider: SECRET_RESOLVER_PROVIDER,
      id: agentModelTokenSecretId(agentId, "openai"),
    },
  };
}

export function openRouterBrokerModelsJson(
  agentId: string,
  input: OpenRouterBrokerModelInput,
): OpenRouterBrokerModelsJson {
  return openRouterBrokerCatalogJson(agentId, {
    baseUrl: input.baseUrl,
    models: [input],
  });
}

export interface OpenRouterBrokerCatalogInput {
  baseUrl: string;
  models: Array<Pick<OpenRouterBrokerModelInput, "model" | "contextTokens">>;
}

export function openRouterCatalogInputForBaseUrl(baseUrl: string): OpenRouterBrokerCatalogInput {
  return {
    baseUrl,
    models: modelCatalogForProvider("openrouter").map((entry) => ({
      model: entry.id,
      ...(typeof entry.contextTokens === "number" ? { contextTokens: entry.contextTokens } : {}),
    })),
  };
}

export function openAiCatalogInputForBaseUrl(baseUrl: string): OpenRouterBrokerCatalogInput {
  return {
    baseUrl,
    models: modelCatalogForProvider("openai").map((entry) => ({
      model: entry.id,
      ...(typeof entry.contextTokens === "number" ? { contextTokens: entry.contextTokens } : {}),
    })),
  };
}

// Model-readiness: every catalog OpenRouter model rides ONE provider entry
// backed by the agent's own broker token — "/models switch" needs no further
// provider surgery, and the broker's plan policy gates what actually serves.
export function openRouterBrokerCatalogJson(
  _agentId: string,
  input: OpenRouterBrokerCatalogInput,
): OpenRouterBrokerModelsJson {
  return {
    providers: {
      [OPENROUTER_BROKER_PROVIDER_ID]: {
        api: "openai-completions",
        baseUrl: input.baseUrl,
        apiKey: OPENROUTER_BROKER_PROFILE_ID,
        models: input.models.map((model) =>
          openRouterBrokerModelConfig({ ...model, baseUrl: input.baseUrl }),
        ),
      },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Which broker provider surfaces this pod carries. A profile whose provider is
 *  unconfigured is pure risk: openclaw's exec resolver is batch-fatal, so one
 *  unresolvable ref colds every other owner on the provider. */
export interface PlatformBrokerProfileSurfaces {
  openRouter: boolean;
  openAi: boolean;
}

interface PlatformBrokerProfileDesire {
  profileId: string;
  provider: string;
  entry: { keyRef: { id: string } };
}

/**
 * The per-agent platform profiles, each pinned to its own owner-scoped broker
 * token. `anthropic:default` is always the broker token: the platform /
 * anthropic-BYOK primary for plain customers and the Haiku-fallback credential
 * for BYOS or non-anthropic-BYOK ones.
 */
function desiredPlatformBrokerProfiles(
  agentId: string,
  surfaces: PlatformBrokerProfileSurfaces,
): PlatformBrokerProfileDesire[] {
  return [
    {
      profileId: ANTHROPIC_DEFAULT_PROFILE_ID,
      provider: "anthropic",
      entry: agentModelTokenProfileEntry(agentId),
    },
    ...(surfaces.openRouter
      ? [{
        profileId: OPENROUTER_BROKER_PROFILE_ID,
        provider: OPENROUTER_BROKER_PROVIDER_ID,
        entry: openRouterBrokerProfileEntry(agentId),
      }]
      : []),
    ...(surfaces.openAi
      ? [{
        profileId: OPENAI_BROKER_PROFILE_ID,
        provider: OPENAI_BROKER_PROVIDER_ID,
        entry: openAiBrokerProfileEntry(agentId),
      }]
      : []),
  ];
}

function profileTarget(
  agentId: string,
  desire: PlatformBrokerProfileDesire,
): AuthProfileApiKeyTarget {
  return authProfileApiKeyTarget({
    agentId,
    profileId: desire.profileId,
    provider: desire.provider,
    refId: desire.entry.keyRef.id,
  });
}

export function platformBrokerProfileTargets(
  agentId: string,
  surfaces: PlatformBrokerProfileSurfaces,
): AuthProfileApiKeyTarget[] {
  return desiredPlatformBrokerProfiles(agentId, surfaces).map((desire) =>
    profileTarget(agentId, desire),
  );
}

/** The store is read-only to us — openclaw's `secrets apply` is the only writer.
 *  Reading it keeps the sweep from spawning the CLI once everything has settled. */
export function missingPlatformBrokerProfileTargets(
  agentDir: string,
  agentId: string,
  surfaces: PlatformBrokerProfileSurfaces,
): AuthProfileApiKeyTarget[] {
  const profiles = asRecord(asRecord(readAuthProfileStore(agentDir)).profiles);
  return desiredPlatformBrokerProfiles(agentId, surfaces)
    .filter((desire) => !profileRefMatches(profiles[desire.profileId], desire))
    .map((desire) => profileTarget(agentId, desire));
}

/** openclaw stores the resolved key alongside the ref, so an applied profile is
 *  never byte-equal to the desired entry — the ref identity is what settles it. */
function profileRefMatches(stored: unknown, desire: PlatformBrokerProfileDesire): boolean {
  const profile = asRecord(stored);
  return (
    profile.type === "api_key" &&
    profile.provider === desire.provider &&
    asRecord(profile.keyRef).id === desire.entry.keyRef.id
  );
}

function readJsonFile(pathname: string): Record<string, unknown> {
  if (!fs.existsSync(pathname)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(pathname, "utf8")) as unknown;
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function writeJsonFile(pathname: string, value: unknown): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function upsertOpenRouterBrokerModel(
  agentDir: string,
  input: OpenRouterBrokerModelInput,
): boolean {
  return upsertOpenRouterBrokerCatalog(agentDir, {
    baseUrl: input.baseUrl,
    models: [input],
  });
}

export function upsertOpenRouterBrokerCatalog(
  agentDir: string,
  input: OpenRouterBrokerCatalogInput,
): boolean {
  return upsertPlatformBrokerCatalog(agentDir, input, {
    providerId: OPENROUTER_BROKER_PROVIDER_ID,
    profileId: OPENROUTER_BROKER_PROFILE_ID,
    marker: OPENROUTER_PLATFORM_MARKER,
  });
}

export function upsertOpenAiBrokerCatalog(
  agentDir: string,
  input: OpenRouterBrokerCatalogInput,
): boolean {
  return upsertPlatformBrokerCatalog(agentDir, input, {
    providerId: OPENAI_BROKER_PROVIDER_ID,
    profileId: OPENAI_BROKER_PROFILE_ID,
    marker: OPENAI_PLATFORM_MARKER,
  });
}

/** The catalog is plain filesystem state and must land whatever the profile
 *  write does: models.json is what makes the model KNOWN to openclaw, and an
 *  unknown model fails the turn outright. */
function upsertPlatformBrokerCatalog(
  agentDir: string,
  input: OpenRouterBrokerCatalogInput,
  ids: {
    providerId: string;
    profileId: string;
    marker: string;
  },
): boolean {
  const modelsPath = path.join(agentDir, "models.json");
  const markerPath = path.join(agentDir, ids.marker);
  const current = readJsonFile(modelsPath);
  const currentProviders = asRecord(current.providers);
  const desired = {
    api: "openai-completions" as const,
    baseUrl: input.baseUrl,
    apiKey: ids.profileId,
    models: input.models.map((model) =>
      openRouterBrokerModelConfig({ ...model, baseUrl: input.baseUrl }),
    ),
  };
  const next = {
    ...current,
    providers: {
      ...currentProviders,
      [ids.providerId]: desired,
    },
  };
  const changed =
    JSON.stringify(current) !== JSON.stringify(next) || !fs.existsSync(markerPath);
  if (!changed) return false;
  writeJsonFile(modelsPath, next);
  fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
  return true;
}

export function removeOpenRouterBrokerModel(agentDir: string): boolean {
  const markerPath = path.join(agentDir, OPENROUTER_PLATFORM_MARKER);
  if (!fs.existsSync(markerPath)) return false;
  const modelsPath = path.join(agentDir, "models.json");
  if (fs.existsSync(modelsPath)) {
    const current = readJsonFile(modelsPath);
    const providers = asRecord(current.providers);
    if (Object.prototype.hasOwnProperty.call(providers, OPENROUTER_BROKER_PROVIDER_ID)) {
      Reflect.deleteProperty(providers, OPENROUTER_BROKER_PROVIDER_ID);
      const next =
        Object.keys(providers).length === 0
          ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== "providers"))
          : { ...current, providers };
      if (Object.keys(next).length === 0) {
        fs.rmSync(modelsPath);
      } else {
        writeJsonFile(modelsPath, next);
      }
    }
  }
  fs.rmSync(markerPath);
  return true;
}

function catalogState(
  configured: OpenRouterBrokerCatalogInput | undefined,
  wrote: boolean,
): string {
  if (!configured) return "unconfigured";
  return wrote ? "written" : "ok";
}

/** Agents whose catalogs landed but whose profiles openclaw has not accepted
 *  yet. `materialized` counts agents with any write. The reason travels with the
 *  result rather than being logged per agent: this sweep is level-triggered, and
 *  a line printed here would reprint on every tick forever. */
export interface BrokerProfileSweepResult {
  materialized: number;
  deferred: string[];
  deferralReason?: string;
}

export interface BrokerProfileSweepOptions {
  agentsDir?: string;
  openRouter?: OpenRouterBrokerCatalogInput;
  openAi?: OpenRouterBrokerCatalogInput;
  logFn?: (m: string) => void;
  /** Child-process seam for `openclaw secrets apply`. */
  secretsApply?: ApplyOpenClawSecretsPlanOptions;
}

/**
 * Hands the agent's missing platform profiles to openclaw. A refused apply is a
 * deferral, not a failure: pre-boot there is no gateway to accept it, and the
 * level-triggered sweep retries every tick until it lands.
 */
interface AgentMaterializeOutcome {
  wrote: boolean;
  deferralReason?: string;
}

async function applyMissingPlatformBrokerProfiles(
  agentHome: string,
  agentId: string,
  opts: BrokerProfileSweepOptions,
): Promise<AgentMaterializeOutcome> {
  const missing = missingPlatformBrokerProfileTargets(agentHome, agentId, {
    openRouter: opts.openRouter !== undefined,
    openAi: opts.openAi !== undefined,
  });
  if (missing.length === 0) return { wrote: false };
  try {
    await applyOpenClawSecretsPlan(buildOpenClawSecretsPlan(missing), opts.secretsApply ?? {});
    return { wrote: true };
  } catch (error) {
    if (!(error instanceof OpenClawSecretsApplyError)) throw error;
    return { wrote: false, deferralReason: error.message };
  }
}

async function materializeOneAgent(
  agentId: string,
  agentsDir: string,
  opts: BrokerProfileSweepOptions,
): Promise<AgentMaterializeOutcome> {
  const agentHome = path.join(agentsDir, agentId, "agent");
  const catalog = opts.openRouter
    ? upsertOpenRouterBrokerCatalog(agentHome, opts.openRouter)
    : false;
  const openAi = opts.openAi
    ? upsertOpenAiBrokerCatalog(agentHome, opts.openAi)
    : false;
  const profiles = await applyMissingPlatformBrokerProfiles(agentHome, agentId, opts);

  const wrote = profiles.wrote || catalog || openAi;
  if (wrote) {
    opts.logFn?.(
      `[agent-model-token] model-ready: ${agentId}` +
        ` (profiles ${profiles.wrote ? "applied" : "ok"},` +
        ` openrouter ${catalogState(opts.openRouter, catalog)},` +
        ` openai ${catalogState(opts.openAi, openAi)})`,
    );
  }
  return { wrote, ...(profiles.deferralReason ? { deferralReason: profiles.deferralReason } : {}) };
}

/**
 * Model-ready sweep: assert every broker provider surface per agent — the
 * platform auth profiles AND the OpenRouter/OpenAI catalogs (when the broker's
 * base URLs are configured). After this, switching any agent to any catalog
 * model is a pure roster flip. Tolerant — a failure on one agent never aborts
 * the sweep.
 */
export async function materializeBrokerProfilesForAgents(
  agentIds: string[],
  opts: BrokerProfileSweepOptions = {},
): Promise<BrokerProfileSweepResult> {
  const agentsDir = opts.agentsDir ?? AGENTS_DIR;
  let materialized = 0;
  let deferralReason: string | undefined;
  const deferred: string[] = [];
  for (const agentId of agentIds) {
    if (!COACH_AGENT_RE.test(agentId)) {
      opts.logFn?.(
        `[agent-model-token] skipping ${agentId} — only octogee-<slug>-coach agents are broker-token resolvable`,
      );
      continue;
    }
    try {
      const result = await materializeOneAgent(agentId, agentsDir, { ...opts, agentsDir });
      if (result.wrote) materialized++;
      if (result.deferralReason) {
        deferred.push(agentId);
        deferralReason ??= result.deferralReason;
      }
    } catch (e) {
      opts.logFn?.(
        `⚠ [agent-model-token] model-ready materialize failed for ${agentId}: ${(e as Error).message}`,
      );
    }
  }
  return { materialized, deferred, ...(deferralReason ? { deferralReason } : {}) };
}
