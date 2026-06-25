import * as path from "node:path";

import { readAuthProfileStore, writeAuthProfileStore } from "./auth-profile-sqlite.js";
import { AGENTS_DIR } from "./config.js";

// The per-agent broker-token anthropic profile for shared (multi-tenant) pods.
// Each customer-agent's anthropic:default resolves to its OWN owner-scoped broker
// token (the secret-resolver fetches it via POST /internal/byok/agent-model-token);
// the broker then resolves platform-or-BYOK per owner. The id is the static
// `agent-model-token-<agentId>` the resolver grammar pins (AGENT_MODEL_TOKEN_ID_RE).
const SECRET_RESOLVER_PROVIDER = "gcp-secret-manager";
const ANTHROPIC_DEFAULT_PROFILE_ID = "anthropic:default";

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

export function agentModelTokenSecretId(agentId: string): string {
  return `agent-model-token-${agentId}`;
}

export function agentModelTokenProfileEntry(agentId: string): AnthropicBrokerProfileEntry {
  return {
    type: "api_key",
    provider: "anthropic",
    keyRef: {
      source: "exec",
      provider: SECRET_RESOLVER_PROVIDER,
      id: agentModelTokenSecretId(agentId),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Upsert the per-agent broker-token `anthropic:default` profile, MERGING into the
 * agent's existing auth-profile store.
 *
 * The store is last-writer-wins on a single JSON blob, and a byosub OAuth profile
 * (openai-codex / anthropic:claude-cli) may already be the agent's PRIMARY — so we
 * read-merge-write to add anthropic:default without clobbering it, and preserve the
 * store's top-level (e.g. an OAuth store's `version`). anthropic:default is always
 * the broker token here: it is the platform/anthropic-BYOK primary for plain
 * customers and the Haiku-fallback credential for BYOS/non-anthropic-BYOK ones.
 *
 * Idempotent — returns false (no write) when the desired profile is already present.
 */
export function upsertAnthropicBrokerProfile(agentDir: string, agentId: string): boolean {
  const store = asRecord(readAuthProfileStore(agentDir));
  const profiles = asRecord(store.profiles);
  const desired = agentModelTokenProfileEntry(agentId);
  if (JSON.stringify(profiles[ANTHROPIC_DEFAULT_PROFILE_ID]) === JSON.stringify(desired)) {
    return false;
  }
  writeAuthProfileStore(agentDir, {
    ...store,
    profiles: { ...profiles, [ANTHROPIC_DEFAULT_PROFILE_ID]: desired },
  });
  return true;
}

/**
 * Boot/reconcile materialization: ensure every shared customer-agent has its
 * anthropic:default broker-token profile. Idempotent + tolerant — a failure on
 * one agent (corrupt store, missing dir) never aborts the sweep. Returns the
 * count actually written. `agentsDir` is injectable for tests.
 */
export function materializeAnthropicBrokerForAgents(
  agentIds: string[],
  opts: { agentsDir?: string; logFn?: (m: string) => void } = {},
): number {
  const agentsDir = opts.agentsDir ?? AGENTS_DIR;
  let count = 0;
  for (const agentId of agentIds) {
    if (!COACH_AGENT_RE.test(agentId)) {
      opts.logFn?.(
        `[agent-model-token] skipping ${agentId} — only octogee-<slug>-coach agents are broker-token resolvable`,
      );
      continue;
    }
    try {
      if (upsertAnthropicBrokerProfile(path.join(agentsDir, agentId, "agent"), agentId)) {
        count++;
        opts.logFn?.(`[agent-model-token] materialized anthropic broker profile for ${agentId}`);
      }
    } catch (e) {
      opts.logFn?.(
        `⚠ [agent-model-token] materialize failed for ${agentId}: ${(e as Error).message}`,
      );
    }
  }
  return count;
}
