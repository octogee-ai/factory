import { parseAgentId, projectAgentId } from "../../shared/types/identity.js";
import { platformOpenAiEmbeddingSecretId } from "@octogee/core/platform-embedding-refs";
import {
  mattermostAccountSecretRef,
  type MattermostAccountSecretRef,
} from "./mattermost-account-secrets.js";

export {
  PLATFORM_EMBEDDING_SECRET_PREFIX,
  platformOpenAiEmbeddingSecretId,
  rebindPlatformEmbeddingRefs,
} from "@octogee/core/platform-embedding-refs";

const PLATFORM_EMBEDDING_PROVIDER = "openai-compatible";
// In-cluster K8s Service DNS (llm-broker), same as the Helm default it
// mirrors; no cross-network hop, no plaintext-in-transit exposure.
// eslint-disable-next-line sonarjs/no-clear-text-protocols
const DEFAULT_OPENAI_EMBEDDINGS_BASE_URL = "http://llm-broker:3010/v1";
const DEFAULT_OPENAI_EMBEDDINGS_MODEL = "text-embedding-3-small";
const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;

export const PRODUCTIVITY_TOOL_NAMES = [
  "octogee_google_calendar_list",
  "octogee_google_gmail_read",
  "octogee_google_gmail_write",
  "octogee_google_drive_read",
  "octogee_google_docs_read",
  "octogee_google_docs_write",
  "octogee_google_contacts_read",
  "octogee_google_calendar_read",
  "octogee_google_calendar_write",
  "octogee_google_tasks_read",
  "octogee_google_tasks_write",
  "octogee_google_sheets_read",
  "octogee_google_sheets_write",
  "octogee_obsidian_read",
  "octogee_obsidian_write",
] as const;

export const RETIRED_LOCAL_PROJECT_EXECUTION_TOOLS = [
  "preview_start",
  "preview_stop",
  "preview_list",
  "octogee_publish",
] as const;

export const WORKSPACE_COACH_ALLOWED_TOOLS = [
  "octogee_project_create",
  "octogee_project_commit",
  "octogee_project_list",
  "octogee_project_set_recipe",
  "octogee_project_capability",
  "octogee_project_build",
  "octogee_project_test",
  "octogee_project_preview",
  "octogee_project_run_status",
  "octogee_project_publish",
  "octogee_board_list",
  "octogee_board_card_read",
  "octogee_board_card_create",
  "octogee_board_card_update",
  "octogee_board_card_move",
  "octogee_board_card_comment",
  "delegated_access",
  "workspace_commit",
  "brave_search",
  "tavily_search",
  "tavily_extract",
  "octogee_chat_search",
  "octogee_chat_history",
  "octogee_chat_set_identity",
  "octogee_status",
  "octogee_ask_ops",
  ...PRODUCTIVITY_TOOL_NAMES,
] as const;

export const PROJECT_AGENT_ALLOWED_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "apply_patch",
  "web_search",
  "web_fetch",
  "brave_search",
  "tavily_search",
  "tavily_extract",
  "octogee_project_commit",
  "octogee_project_capability",
  "octogee_project_build",
  "octogee_project_test",
  "octogee_project_preview",
  "octogee_project_run_status",
  "octogee_project_set_recipe",
  "octogee_board_list",
  "octogee_board_card_read",
  "octogee_board_card_create",
  "octogee_board_card_update",
  "octogee_board_card_move",
  "octogee_board_card_comment",
] as const;

export const PROJECT_AGENT_DENIED_TOOLS = [
  ...PRODUCTIVITY_TOOL_NAMES,
  "exec",
  "process",
  "subagents",
  "sessions_spawn",
  "terminal",
  ...RETIRED_LOCAL_PROJECT_EXECUTION_TOOLS,
  "workspace_commit",
  "octogee_project_create",
  "octogee_project_publish",
  "delegated_access",
  "octogee_status",
  "octogee_chat_search",
  "octogee_chat_history",
  "octogee_chat_set_identity",
  "bundle-mcp",
  "automations",
  "skill_workshop",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "browser",
] as const;

function workspaceCoachTools(): Record<string, unknown> {
  return {
    profile: "coding",
    alsoAllow: WORKSPACE_COACH_ALLOWED_TOOLS,
    deny: RETIRED_LOCAL_PROJECT_EXECUTION_TOOLS,
    fs: { workspaceOnly: true },
    toolsBySender: {},
  };
}

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
  customerMmUserId?: string | null;
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
    tools: workspaceCoachTools(),
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
  channels?: ReadonlyArray<BindingChannelInput>;
  agentProjects?: ReadonlySet<string>;
}

export interface MattermostAccountEntry {
  botToken: MattermostAccountSecretRef;
  allowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: string[];
  /** Only ever `null` — see buildMattermostAccounts. The plugin's group entry
   *  schema omits `enabled`, so there is no per-channel mute to express; the
   *  key exists solely to clear entries written before 2026.7.2. */
  groups?: null;

commands?: {
    native: false;
  };
}

export function buildMattermostAccounts(
  customers: ReadonlyArray<MattermostAccountInput>,
  coachTokens: ReadonlyMap<string, string>,
  adminMmUserId?: string | null,
  warn: (msg: string) => void = () => {},
): Record<string, MattermostAccountEntry> {
  const accounts: Record<string, MattermostAccountEntry> = {};
  for (const c of customers) {
    const token = coachTokens.get(c.uid);
    if (!token) continue;
    const groupAllowFrom = [c.customerMmUserId, adminMmUserId].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    if (groupAllowFrom.length === 0) {
      warn(`Skipping ${c.slug}-coach Mattermost account: sender allowlist is empty`);
      continue;
    }
    // Per-channel mutes are not expressible: the mattermost plugin builds its
    // group entry as buildGroupEntrySchema().omit({ skills, enabled, allowFrom,
    // systemPrompt }), so `enabled` is rejected outright and config.patch fails
    // the whole document — taking the mount, and every customer queued behind
    // it in the same reconcile batch, down with it. Clearing the key is also
    // the repair path for configs a prior release already wrote.
    // Project channels reach the project agent through its own account and MM
    // membership; the workspace coach is deliberately not a channel member.
    const managesGroups = c.channels !== undefined && c.agentProjects !== undefined;
    const groupsPatch: Pick<MattermostAccountEntry, "groups"> = managesGroups
      ? { groups: null }
      : {};
    const accountId = `${c.slug}-coach`;
    const ownerAllowFrom = typeof c.customerMmUserId === "string" &&
        MATTERMOST_ID_RE.test(c.customerMmUserId)
      ? [c.customerMmUserId]
      : [];
    accounts[accountId] = {
      botToken: mattermostAccountSecretRef(accountId),
      allowFrom: ownerAllowFrom,
      groupPolicy: "allowlist",
      groupAllowFrom,
      ...groupsPatch,
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
    peer?: { kind: "group"; id: string };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAccountBinding(value: unknown): value is OpenClawBinding {
  if (!isRecord(value) || typeof value.agentId !== "string") return false;
  const match = value.match;
  return isRecord(match) &&
    match.channel === "mattermost" &&
    typeof match.accountId === "string" &&
    match.peer === undefined;
}

function mattermostBindingKey(value: unknown): string | null {
  if (!isRecord(value) || typeof value.agentId !== "string") return null;
  const match = value.match;
  if (
    !isRecord(match) ||
    match.channel !== "mattermost" ||
    typeof match.accountId !== "string"
  ) {
    return null;
  }
  if (match.peer === undefined) {
    return `${match.accountId}\u0000${value.agentId}\u0000account`;
  }
  if (
    !isRecord(match.peer) ||
    typeof match.peer.kind !== "string" ||
    typeof match.peer.id !== "string"
  ) {
    return `${match.accountId}\u0000${value.agentId}\u0000malformed`;
  }
  return `${match.accountId}\u0000${value.agentId}\u0000${match.peer.kind}\u0000${match.peer.id}`;
}

export function mattermostAccountBindingsNeedActivation(
  current: readonly unknown[],
  desired: readonly OpenClawBinding[],
): boolean {
  return mattermostAccountBindingsNeedingActivation(current, desired).length > 0;
}

export function mattermostAccountBindingsNeedingActivation(
  current: readonly unknown[],
  desired: readonly OpenClawBinding[],
): string[] {
  const desiredAccountIds = new Set(
    desired.filter(isAccountBinding).map((binding) => binding.match.accountId),
  );
  const desiredAgentUsernames = new Set(desired.flatMap((binding) => {
    const parsed = parseAgentId(binding.agentId);
    return parsed.kind === "unknown" ? [] : [parsed.username];
  }));
  const desiredRoutes = new Set(desired.flatMap((binding) => {
    const key = mattermostBindingKey(binding);
    return key ? [key] : [];
  }));
  const currentRoutes = new Set(current.flatMap((binding) => {
    const key = mattermostBindingKey(binding);
    return key ? [key] : [];
  }));
  const needsActivation = new Set<string>();

  for (const binding of desired.filter(isAccountBinding)) {
    const key = mattermostBindingKey(binding)!;
    if (!currentRoutes.has(key)) needsActivation.add(binding.match.accountId);
  }
  for (const binding of current) {
    const key = mattermostBindingKey(binding);
    if (!key) continue;
    const accountId = key.slice(0, key.indexOf("\u0000"));
    const agentId = isRecord(binding) && typeof binding.agentId === "string"
      ? binding.agentId
      : "";
    const parsedAgentId = parseAgentId(agentId);
    const managedAgent = parsedAgentId.kind !== "unknown" &&
      desiredAgentUsernames.has(parsedAgentId.username);
    if (
      (desiredAccountIds.has(accountId) || managedAgent) &&
      !desiredRoutes.has(key)
    ) {
      needsActivation.add(accountId);
    }
  }
  return [...needsActivation].sort();
}

export const SAFE_DEFAULT_AGENT_ID = "octogee-unmatched-route";

export function buildSafeDefaultAgent(): Record<string, unknown> {
  return {
    id: SAFE_DEFAULT_AGENT_ID,
    name: "Unmatched Mattermost route",
    heartbeat: { every: "0m" },
    tools: {
      profile: "minimal",
      alsoAllow: [],
      fs: { workspaceOnly: true },
    },
  };
}

function withoutDefault(agent: unknown): unknown {
  if (agent === null || typeof agent !== "object" || Array.isArray(agent)) return agent;
  const entry = { ...(agent as Record<string, unknown>) };
  delete entry.default;
  return entry;
}

export function gatewayAgentRoster(
  agents: readonly unknown[],
  builderSlug: string = gatewayAgentRosterBuilderSlug(),
): unknown[] {
  const retained = agents
    .filter((agent) => !(
      agent !== null &&
      typeof agent === "object" &&
      !Array.isArray(agent) &&
      (agent as { id?: unknown }).id === SAFE_DEFAULT_AGENT_ID
    ));
  const withoutExistingDefault = retained.map(withoutDefault);
  if (!builderSlug) return [buildSafeDefaultAgent(), ...withoutExistingDefault];
  return withoutExistingDefault;
}

export function gatewayAgentRosterBuilderSlug(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const gatewayClass = env.GATEWAY_CLASS?.trim();
  if (gatewayClass === "shared") return "";
  if (gatewayClass === "builder") return env.GATEWAY_BUILDER_SLUG?.trim() || "";
  return "";
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
  ownerMmUserId?: string | null;
}

export function buildProjectAgents(input: ProjectAgentsBuildInput): Array<Record<string, unknown>> {
  const active = activeAgentProjectIds(input.projectAgents);
  return input.projectAgents
    .filter((p) => active.has(p.projectId))
    .map((p) => {
      const agentId = projectAgentId(input.slug, p.projectId);
      const ownerToolPolicy = workspaceCoachTools();
      return {
        id: agentId,
        name: `${input.coach.name} (${input.slug}/${p.projectId})`,
        workspace: `${input.customerDir}/projects/${p.projectId}`,
        agentDir: `${input.agentsDir}/${agentId}/agent`,
        model: input.coach.model,
        identity: { name: input.coach.name, emoji: input.coach.emoji },
        tools: {
          ...ownerToolPolicy,
          profile: "minimal",
          alsoAllow: PROJECT_AGENT_ALLOWED_TOOLS,
          deny: PROJECT_AGENT_DENIED_TOOLS,
          exec: { mode: "deny", host: "node" },
          fs: { workspaceOnly: true },
        },
      };
    });
}

export function buildProjectAgentAccounts(
  slug: string,
  projectAgents: ReadonlyArray<ProjectAgentState>,
  ownerMmUserId?: string | null,
): Record<string, MattermostAccountEntry> {
  const active = activeAgentProjectIds(projectAgents);
  const accounts: Record<string, MattermostAccountEntry> = {};
  for (const p of projectAgents) {
    if (!active.has(p.projectId) || !p.token) continue;
    const accountId = `${slug}-proj-${p.projectId}`;
    accounts[accountId] = {
      botToken: mattermostAccountSecretRef(accountId),
      allowFrom: typeof ownerMmUserId === "string" && MATTERMOST_ID_RE.test(ownerMmUserId)
        ? [ownerMmUserId]
        : [],
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
    const projectIds = [...(c.agentProjects ?? [])].sort();
    const accountBindings: OpenClawBinding[] = [
      {
        agentId: coachAgentId,
        match: {
          channel: "mattermost",
          accountId: coachAccountId,
        },
      },
      ...projectIds.map((projectId) => ({
        agentId: projectAgentId(c.slug, projectId),
        match: {
          channel: "mattermost" as const,
          accountId: `${c.slug}-proj-${projectId}`,
        },
      })),
    ];
    const peerBindings = c.channels.map((binding) => {
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
    return [...accountBindings, ...peerBindings];
  });
}
