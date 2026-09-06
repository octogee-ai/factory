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
import { modelCatalogForProvider, type ModelInputModality } from "@octogee/shared/types/model-catalog";
import { parseAgentId } from "@octogee/shared/types/identity";

export { OpenClawSecretsApplyError } from "./openclaw-secrets-apply.js";

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
const QUIET_NON_BROKER_AGENT_IDS = new Set(["octogee-unmatched-route"]);

function isBrokerResolvableAgentId(agentId: string): boolean {
  return parseAgentId(agentId).kind !== "unknown";
}

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
  input?: readonly ModelInputModality[];
}

export interface OpenRouterBrokerProviderConfigInput extends OpenRouterBrokerModelInput {
  apiKey: string;
}

export interface OpenRouterBrokerProviderConfig {
  api: "openai-completions";
  baseUrl: string;
  apiKey: string;
  models: OpenRouterBrokerModelConfig[];
}

export interface OpenRouterBrokerModelConfig {
  id: string;
  name: string;
  contextTokens?: number;
  contextWindow?: number;
  input?: ModelInputModality[];
}

export interface OpenRouterBrokerModelsJson {
  providers: Record<string, {
    api: "openai-completions";
    baseUrl: string;
    apiKey: string;
    models: OpenRouterBrokerModelConfig[];
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

export function openRouterBrokerModelConfig(
  input: Pick<OpenRouterBrokerModelInput, "model" | "contextTokens" | "input">,
): OpenRouterBrokerModelConfig {
  return {
    id: input.model,
    name: input.model,
    ...(typeof input.contextTokens === "number"
      ? { contextTokens: input.contextTokens, contextWindow: input.contextTokens }
      : {}),
    ...(input.input ? { input: [...input.input] } : {}),
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
  models: Array<Pick<OpenRouterBrokerModelInput, "model" | "contextTokens" | "input">>;
}

export function openRouterCatalogInputForBaseUrl(baseUrl: string): OpenRouterBrokerCatalogInput {
  return {
    baseUrl,
    models: modelCatalogForProvider("openrouter").map((entry) => ({
      model: entry.id,
      ...(typeof entry.contextTokens === "number" ? { contextTokens: entry.contextTokens } : {}),
      ...(entry.input ? { input: entry.input } : {}),
    })),
  };
}

export function openAiCatalogInputForBaseUrl(baseUrl: string): OpenRouterBrokerCatalogInput {
  return {
    baseUrl,
    models: modelCatalogForProvider("openai").map((entry) => ({
      model: entry.id,
      ...(typeof entry.contextTokens === "number" ? { contextTokens: entry.contextTokens } : {}),
      ...(entry.input ? { input: entry.input } : {}),
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
        models: input.models.map(openRouterBrokerModelConfig),
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
      openRouterBrokerModelConfig(model),
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
  secretsApply?: ApplyOpenClawSecretsPlanOptions;
}

interface AgentMaterializeOutcome {
  agentId: string;
  catalogWrote: boolean;
  openAiWrote: boolean;
  missingProfiles: AuthProfileApiKeyTarget[];
}

interface PreparedAgentMaterializations {
  agents: AgentMaterializeOutcome[];
  deferred: string[];
  deferralReason?: string;
}

interface AppliedAgentMaterializations {
  profilesApplied: boolean;
  deferred: string[];
  deferralReason?: string;
}

function prepareAgentMaterialization(
  agentId: string,
  agentsDir: string,
  opts: BrokerProfileSweepOptions,
): AgentMaterializeOutcome {
  const agentHome = path.join(agentsDir, agentId, "agent");
  const catalogWrote = opts.openRouter
    ? upsertOpenRouterBrokerCatalog(agentHome, opts.openRouter)
    : false;
  const openAiWrote = opts.openAi
    ? upsertOpenAiBrokerCatalog(agentHome, opts.openAi)
    : false;
  return {
    agentId,
    catalogWrote,
    openAiWrote,
    missingProfiles: missingPlatformBrokerProfileTargets(agentHome, agentId, {
      openRouter: opts.openRouter !== undefined,
      openAi: opts.openAi !== undefined,
    }),
  };
}

function prepareAgentMaterializations(
  agentIds: string[],
  agentsDir: string,
  opts: BrokerProfileSweepOptions,
): PreparedAgentMaterializations {
  const agents: AgentMaterializeOutcome[] = [];
  const deferred: string[] = [];
  let deferralReason: string | undefined;
  for (const agentId of new Set(agentIds)) {
    if (!isBrokerResolvableAgentId(agentId)) {
      if (!QUIET_NON_BROKER_AGENT_IDS.has(agentId)) {
        opts.logFn?.(
          `[agent-model-token] skipping ${agentId} — not a canonical workspace or project agent id`,
        );
      }
      continue;
    }
    try {
      agents.push(prepareAgentMaterialization(agentId, agentsDir, { ...opts, agentsDir }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      opts.logFn?.(
        `⚠ [agent-model-token] model-ready materialize failed for ${agentId}: ${reason}`,
      );
      deferred.push(agentId);
      deferralReason ??= reason;
    }
  }
  return { agents, deferred, ...(deferralReason ? { deferralReason } : {}) };
}

async function applyAgentMaterializations(
  agents: AgentMaterializeOutcome[],
  opts: BrokerProfileSweepOptions,
): Promise<AppliedAgentMaterializations> {
  const targets = agents.flatMap((agent) => agent.missingProfiles);
  if (targets.length === 0) return { profilesApplied: false, deferred: [] };
  try {
    await applyOpenClawSecretsPlan(buildOpenClawSecretsPlan(targets), opts.secretsApply ?? {});
    return { profilesApplied: true, deferred: [] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!(error instanceof OpenClawSecretsApplyError)) {
      opts.logFn?.(`⚠ [agent-model-token] model-ready secrets apply failed: ${reason}`);
    }
    return {
      profilesApplied: false,
      deferred: agents
        .filter((agent) => agent.missingProfiles.length > 0)
        .map((agent) => agent.agentId),
      deferralReason: reason,
    };
  }
}

function profileMaterializationState(
  agent: AgentMaterializeOutcome,
  profilesApplied: boolean,
): "applied" | "deferred" | "ok" {
  if (agent.missingProfiles.length === 0) return "ok";
  return profilesApplied ? "applied" : "deferred";
}

function reportAgentMaterializations(
  agents: AgentMaterializeOutcome[],
  profilesApplied: boolean,
  opts: BrokerProfileSweepOptions,
): number {
  let materialized = 0;
  for (const agent of agents) {
    const profileWrote = profilesApplied && agent.missingProfiles.length > 0;
    if (!profileWrote && !agent.catalogWrote && !agent.openAiWrote) continue;
    materialized++;
    opts.logFn?.(
      `[agent-model-token] model-ready: ${agent.agentId}` +
        ` (profiles ${profileMaterializationState(agent, profilesApplied)},` +
        ` openrouter ${catalogState(opts.openRouter, agent.catalogWrote)},` +
        ` openai ${catalogState(opts.openAi, agent.openAiWrote)})`,
    );
  }
  return materialized;
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
  const prepared = prepareAgentMaterializations(agentIds, agentsDir, opts);
  const applied = await applyAgentMaterializations(prepared.agents, opts);
  const materialized = reportAgentMaterializations(
    prepared.agents,
    applied.profilesApplied,
    opts,
  );
  const deferralReason = prepared.deferralReason ?? applied.deferralReason;
  return {
    materialized,
    deferred: [...prepared.deferred, ...applied.deferred],
    ...(deferralReason ? { deferralReason } : {}),
  };
}
