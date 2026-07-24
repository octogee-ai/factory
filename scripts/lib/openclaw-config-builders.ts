import { projectAgentId } from "../../shared/types/identity.js";
import {
  mattermostAccountSecretRef,
  type MattermostAccountSecretRef,
} from "./mattermost-account-secrets.js";

const PLATFORM_EMBEDDING_PROVIDER = "openai-compatible";
const DEFAULT_OPENAI_EMBEDDINGS_BASE_URL = "http://llm-broker:3010/v1";
const DEFAULT_OPENAI_EMBEDDINGS_MODEL = "text-embedding-3-small";

function normalizedNonEmpty(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function normalizedBaseUrl(value: string | undefined): string {
  let baseUrl = normalizedNonEmpty(value, DEFAULT_OPENAI_EMBEDDINGS_BASE_URL);
  while (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }
  return baseUrl;
}

export function platformOpenAiEmbeddingSecretId(agentId: string): string {
  return `agent-model-token-openai-${agentId}`;
}

export function platformOpenAiEmbeddingMemorySearch(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  return {
    provider: PLATFORM_EMBEDDING_PROVIDER,
    remote: {
      baseUrl: normalizedBaseUrl(env.PLATFORM_OPENAI_BASE_URL),
      apiKey: {
        source: "exec",
        provider: "gcp-secret-manager",
        id: platformOpenAiEmbeddingSecretId(agentId),
      },
    },
    model: normalizedNonEmpty(env.OPENAI_EMBEDDINGS_MODEL, DEFAULT_OPENAI_EMBEDDINGS_MODEL),
  };
}

export function platformOpenAiEmbeddingsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return /^(1|true|yes|on)$/iu.test(env.OPENAI_EMBEDDINGS_ENABLED ?? "");
}

const PLATFORM_EMBEDDING_SECRET_PREFIX = "agent-model-token-openai-";
const OPENCLAW_REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A platform embedding SecretRef is DERIVED from its agent id, never carried.
// Two corruption vectors make carrying fatal: (1) a full agents.list rebuilt
// from a shifted `current` hands one coach another coach's ref, and (2) —
// the live r9 wedge — config.get REDACTS the id to __OPENCLAW_REDACTED__ and
// the server back-substitutes sentinels BY ARRAY INDEX on patch-apply, so any
// removal shifts every survivor. Rewriting sentinels to the derived id here
// means our patches carry real values and the server has nothing to
// substitute. Safe because buildCustomerAgent is the only writer of
// exec/gcp-secret-manager embedding refs on gateway pods — a future BYO
// embedding ref must use a distinguishable source/provider shape. Non-platform
// (BYO-shaped) ids pass through untouched.
export function rebindPlatformEmbeddingRefs(agents: readonly unknown[]): unknown[] {
  return agents.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) return entry;
    const memorySearch = entry.memorySearch;
    if (!isRecord(memorySearch)) return entry;
    const remote = memorySearch.remote;
    if (!isRecord(remote)) return entry;
    const apiKey = remote.apiKey;
    if (!isRecord(apiKey) || typeof apiKey.id !== "string") return entry;
    const platformShaped =
      apiKey.id.startsWith("platform-openai-embedding-") ||
      apiKey.id.startsWith(PLATFORM_EMBEDDING_SECRET_PREFIX) ||
      (apiKey.id === OPENCLAW_REDACTED_SENTINEL &&
        apiKey.source === "exec" &&
        apiKey.provider === "gcp-secret-manager");
    if (!platformShaped) return entry;
    const expected = platformOpenAiEmbeddingSecretId(entry.id);
    if (apiKey.id === expected) return entry;
    return {
      ...entry,
      memorySearch: {
        ...memorySearch,
        remote: { ...remote, apiKey: { ...apiKey, id: expected } },
      },
    };
  });
}

export interface ProjectRestoreInput {
  customerSlug: string;
  projectSlug: string;
  giteaRepoName: string | null;
  provisioningState?: string;
}

export function projectsNeedingClone(
  inputs: readonly ProjectRestoreInput[],
  isProjectCloned: (customerSlug: string, projectSlug: string) => boolean,
): ProjectRestoreInput[] {
  return inputs.filter((p) => {
    if (!p.giteaRepoName) return false;
    if (p.provisioningState !== undefined && p.provisioningState !== "active") return false;
    if (isProjectCloned(p.customerSlug, p.projectSlug)) return false;
    return true;
  });
}

export interface CustomerAgentInput {
  uid: string;
  slug: string;
  customerDir: string;
  agentDir: string;
  coach: { name: string; emoji: string; model: string };
  default?: boolean;
  memorySearch?: Record<string, unknown>;
}

export function buildCustomerAgent(
  c: CustomerAgentInput,
): Record<string, unknown> {
  const agentId = `octogee-${c.slug}-coach`;

  const agent: Record<string, unknown> = {
    id: agentId,
    name: `${c.coach.name} (${c.slug})`,
    workspace: c.customerDir,
    agentDir: c.agentDir,
    model: c.coach.model,
    identity: { name: c.coach.name, emoji: c.coach.emoji },
    heartbeat: { every: "60m", target: "last", lightContext: true },
    tools: { fs: { workspaceOnly: true } },
  };
  if (c.default) {
    agent.default = true;
  }
  if (c.memorySearch) {
    agent.memorySearch = c.memorySearch;
  }
  return agent;
}

export interface CoachIdentityDeps {
  db: {
    collection: (name: string) => {
      doc: (id: string) => {
        get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> }>;
      };
    };
  };
  log: (msg: string) => void;
}

export interface CoachIdentity {
  name: string;
  emoji: string;
}

export interface CoachIdentityDefaults {
  name: string;
  emoji: string;
}

export function resolveCoachIdentity(
  custom: CoachIdentity | undefined,
  defaults: CoachIdentityDefaults,
): CoachIdentity {
  return {
    name: (custom?.name && custom.name.length > 0) ? custom.name : defaults.name,
    emoji: (custom?.emoji && custom.emoji.length > 0) ? custom.emoji : defaults.emoji,
  };
}

export async function fetchCoachIdentities(
  deps: CoachIdentityDeps,
  customers: ReadonlyArray<{ uid: string; slug: string }>,
): Promise<Map<string, CoachIdentity>> {
  const out = new Map<string, CoachIdentity>();
  for (const c of customers) {
    try {
      const snap = await deps.db.collection("agents").doc(c.uid).get();
      if (!snap.exists) {
        deps.log(
          `⚠ no agents/${c.uid} doc for ${c.slug} — using default coach identity`,
        );
        continue;
      }
      const data = snap.data() ?? {};
      const name = typeof data.name === "string" && data.name ? data.name : null;
      const emoji =
        typeof data.avatarEmoji === "string" && data.avatarEmoji ? data.avatarEmoji : null;
      if (!name && !emoji) {
        deps.log(
          `⚠ agents/${c.uid} has no name/avatarEmoji for ${c.slug} — using defaults`,
        );
        continue;
      }
      out.set(c.uid, {
        name: name ?? "",
        emoji: emoji ?? "",
      });
    } catch (err) {
      deps.log(
        `⚠ agents/${c.uid} read failed for ${c.slug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return out;
}

export interface CoachTokenDeps {
  db: {
    collection: (name: string) => {
      doc: (id: string) => {
        collection: (name: string) => {
          doc: (id: string) => {
            get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> }>;
          };
        };
      };
    };
  };
  log: (msg: string) => void;
}

export async function fetchCoachTokens(
  deps: CoachTokenDeps,
  customers: ReadonlyArray<{ uid: string; slug: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const c of customers) {
    try {
      const snap = await deps.db
        .collection("users").doc(c.uid)
        .collection("secrets").doc("coachMattermost")
        .get();
      if (!snap.exists) {
        deps.log(
          `⚠ no users/${c.uid}/secrets/coachMattermost for ${c.slug} — coach has no PAT; re-run provisioning`,
        );
        continue;
      }
      const data = snap.data() ?? {};
      const token = typeof data.personalToken === "string" ? data.personalToken : "";
      if (!token) {
        deps.log(
          `⚠ users/${c.uid}/secrets/coachMattermost missing personalToken for ${c.slug}`,
        );
        continue;
      }
      out.set(c.uid, token);
    } catch (err) {
      deps.log(
        `⚠ users/${c.uid}/secrets/coachMattermost read failed for ${c.slug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return out;
}

export interface MattermostAccountInput {
  uid: string;
  slug: string;
  customerMmUserId?: string | null;
}

export interface MattermostAccountEntry {
  botToken: MattermostAccountSecretRef;
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: string[];

commands?: {
    native: false;
  };
}

export function buildMattermostAccounts(
  customers: ReadonlyArray<MattermostAccountInput>,
  coachTokens: ReadonlyMap<string, string>,
  adminMmUserId?: string | null,
  _warn?: (msg: string) => void,
): Record<string, MattermostAccountEntry> {
  const accounts: Record<string, MattermostAccountEntry> = {};
  for (const c of customers) {
    const token = coachTokens.get(c.uid);
    if (!token) continue;
    // Group channels: the coach answers any member of the channels it has been
    // added to. Mattermost channel membership IS the access boundary (auditable
    // + revocable in MM, and the coach is only ever added to channels its owner
    // controls). The prior owner+admin `allowlist` duplicated that boundary and
    // silently dropped invited guests — breaking shared channels, the headline
    // feature. `groupAllowFrom` is retained as an advisory seed (ignored under
    // "open") for a possible future "synced allowlist" mode. See PR.
    const groupAllowFrom = [c.customerMmUserId, adminMmUserId].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    const accountId = `${c.slug}-coach`;
    accounts[accountId] = {
      botToken: mattermostAccountSecretRef(accountId),
      groupPolicy: "open",
      ...(groupAllowFrom.length > 0 ? { groupAllowFrom } : {}),
      commands: { native: false },
    };
  }
  return accounts;
}

export interface OpenClawBinding {
  agentId: string;
  match: {
    channel: "mattermost";
    accountId: string;
    peer: { kind: "group"; id: string };
  };
}

export interface ProjectAgentState {
  projectId: string;
  enabled: boolean;
  mmUserId: string | null;
  token: string | null;
}

// A project agent is ACTIVE (routable, gets an agent entry + account +
// bindings) only once it is enabled AND its MM bot PAT is minted. Everything
// keys off this one predicate so the config can never half-include an agent.
export function activeAgentProjectIds(
  projectAgents: ReadonlyArray<ProjectAgentState>,
): Set<string> {
  return new Set(
    projectAgents
      .filter((p) => p.enabled && typeof p.token === "string" && p.token.length > 0)
      .map((p) => p.projectId),
  );
}

export interface ProjectAgentsBuildInput {
  slug: string;
  customerDir: string;
  agentsDir: string;
  coach: { name: string; emoji: string; model: string };
  projectAgents: ReadonlyArray<ProjectAgentState>;
}

export function buildProjectAgents(input: ProjectAgentsBuildInput): Array<Record<string, unknown>> {
  const active = activeAgentProjectIds(input.projectAgents);
  return input.projectAgents
    .filter((p) => active.has(p.projectId))
    .map((p) => {
      const agentId = projectAgentId(input.slug, p.projectId);
      return {
        id: agentId,
        name: `${input.coach.name} (${input.slug}/${p.projectId})`,
        workspace: `${input.customerDir}/projects/${p.projectId}`,
        agentDir: `${input.agentsDir}/${agentId}/agent`,
        model: input.coach.model,
        identity: { name: input.coach.name, emoji: input.coach.emoji },
        tools: { fs: { workspaceOnly: true } },
      };
    });
}

export function buildProjectAgentAccounts(
  slug: string,
  projectAgents: ReadonlyArray<ProjectAgentState>,
): Record<string, MattermostAccountEntry> {
  const active = activeAgentProjectIds(projectAgents);
  const accounts: Record<string, MattermostAccountEntry> = {};
  for (const p of projectAgents) {
    if (!active.has(p.projectId) || !p.token) continue;
    const accountId = `${slug}-proj-${p.projectId}`;
    accounts[accountId] = {
      botToken: mattermostAccountSecretRef(accountId),
      groupPolicy: "open",
      commands: { native: false },
    };
  }
  return accounts;
}

export interface BindingChannelInput {
  channelId: string;
  scope?: "workspace" | "project";
  projectId?: string;
}

export function buildCustomerBindings(
  customers: ReadonlyArray<{
    slug: string;
    channels: ReadonlyArray<BindingChannelInput>;
    agentProjects?: ReadonlySet<string>;
  }>,
): OpenClawBinding[] {
  return customers.flatMap((c) => {
    const coachAgentId = `octogee-${c.slug}-coach`;
    const coachAccountId = `${c.slug}-coach`;
    return c.channels.map((binding) => {
      const projectAgent =
        binding.scope === "project" &&
        binding.projectId !== undefined &&
        c.agentProjects?.has(binding.projectId) === true;
      return {
        agentId: projectAgent
          ? projectAgentId(c.slug, binding.projectId!)
          : coachAgentId,
        match: {
          channel: "mattermost" as const,
          accountId: projectAgent ? `${c.slug}-proj-${binding.projectId}` : coachAccountId,
          peer: { kind: "group" as const, id: binding.channelId },
        },
      };
    });
  });
}
