import { MODEL_CATALOG, type ModelCatalogEntry } from "./model-catalog.js";

// Per-agent model selection, stored at users/{uid}/system/config.agentModels
// keyed by OpenClaw agent id. Refs use the gateway's model grammar
// (<provider>/<model>, e.g. anthropic/claude-haiku-4-5 or
// platform-openrouter/z-ai/glm-5.2); BYOSUB owners may also store their
// subscription runtimes' refs (claude-cli/..., codex handles its own ids).
// Shape validation lives here; PLAN policy is enforced by the broker and the
// gateway runtime, never by this parser.

export interface AgentModelSelection {
  primary: string;
  fallbacks: string[];
}

export type AgentModelSelections = Record<string, AgentModelSelection>;

export const MAX_AGENT_MODEL_FALLBACKS = 3;

const MODEL_REF_PATTERN = /^[a-z0-9][a-z0-9._:-]*(\/[a-z0-9][a-z0-9._:-]*){1,2}$/i;
const MAX_MODEL_REF_LENGTH = 128;

const AGENT_ID_PATTERN = /^octogee-[a-z0-9][a-z0-9-]*-coach$/;

export const OPENROUTER_PLATFORM_PROVIDER_ID = "platform-openrouter";

export function isValidModelRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_MODEL_REF_LENGTH &&
    MODEL_REF_PATTERN.test(value)
  );
}

export function modelRefForCatalogEntry(entry: ModelCatalogEntry): string {
  return entry.provider === "openrouter"
    ? `${OPENROUTER_PLATFORM_PROVIDER_ID}/${entry.id}`
    : entry.id;
}

export function platformModelRefs(): string[] {
  return MODEL_CATALOG.map(modelRefForCatalogEntry);
}

export function catalogEntryForModelRef(ref: string): ModelCatalogEntry | null {
  return MODEL_CATALOG.find((entry) => modelRefForCatalogEntry(entry) === ref) ?? null;
}

export function parseAgentModelSelection(value: unknown): AgentModelSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { primary, fallbacks } = value as { primary?: unknown; fallbacks?: unknown };
  if (!isValidModelRef(primary)) return null;
  if (fallbacks === undefined) return { primary, fallbacks: [] };
  if (!Array.isArray(fallbacks) || fallbacks.length > MAX_AGENT_MODEL_FALLBACKS) return null;
  if (!fallbacks.every(isValidModelRef)) return null;
  return { primary, fallbacks: [...(fallbacks as string[])] };
}

export function parseAgentModelSelections(value: unknown): AgentModelSelections {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: AgentModelSelections = {};
  for (const [agentId, selection] of Object.entries(value)) {
    if (!AGENT_ID_PATTERN.test(agentId)) continue;
    const parsed = parseAgentModelSelection(selection);
    if (parsed) out[agentId] = parsed;
  }
  return out;
}

export function agentIdBelongsToSlug(agentId: string, slug: string): boolean {
  if (agentId === `octogee-${slug}-coach`) return true;
  const projPrefix = `octogee-${slug}-proj-`;
  return (
    AGENT_ID_PATTERN.test(agentId) && agentId.startsWith(projPrefix) && agentId.endsWith("-coach")
  );
}
