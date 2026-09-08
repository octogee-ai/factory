import { isValidProjectId, projectAgentId } from "../../shared/types/identity.js";
import { customerAgentRosterPatch, customerConfigReplacePaths } from "./apply-config-patch.js";
import { buildCustomerBindings, type BindingChannelInput } from "./openclaw-config-builders.js";
import { mattermostAccountSecretRef } from "./mattermost-account-secrets.js";

type ConfigEntry = Record<string, unknown>;

export function configuredBuilderManagedProjectIds(current: unknown, slug: string, authoritativeIds: readonly string[]): string[] {
  const managed = new Set(authoritativeIds);
  for (const id of managed) {
    if (!isValidProjectId(id)) throw new Error(`invalid managed project ID: ${id}`);
  }
  const prefix = `${slug}-proj-`;
  const accounts = record(record(record(record(current).channels).mattermost).accounts);
  for (const [accountId, account] of Object.entries(accounts)) {
    if (!accountId.startsWith(prefix)) continue;
    const projectId = accountId.slice(prefix.length);
    if (!isValidProjectId(projectId)) continue;
    const token = record(account).botToken;
    if (token === null || typeof token !== "object" || Array.isArray(token)) continue;
    const secret = record(token);
    const canonical = mattermostAccountSecretRef(accountId);
    if (Object.keys(secret).length === 3 && secret.source === canonical.source && secret.provider === canonical.provider && secret.id === canonical.id) {
      managed.add(projectId);
    }
  }
  return [...managed];
}

export interface ConfiguredBuilderProjectAgentInput {
  slug: string;
  managedProjectIds: readonly string[];
  activationProjectIds: readonly string[];
  projectAgentEntries: readonly ConfigEntry[];
  projectAccounts: Record<string, unknown>;
  channels: readonly BindingChannelInput[];
}

export interface ConfiguredBuilderProjectAgentPatch {
  patch: {
    agents: ReturnType<typeof customerAgentRosterPatch>;
    bindings: unknown[];
    channels: { mattermost: { accounts: Record<string, unknown> } };
  };
  replacePaths: string[];
  retiredAgentIds: string[];
}

function record(value: unknown): ConfigEntry {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("project reconciliation expected a config object");
  return value as ConfigEntry;
}

function currentRoster(current: unknown): ConfigEntry[] {
  const agents = record(record(current).agents);
  if (agents.entries !== undefined) {
    return Object.entries(record(agents.entries)).map(([id, entry]) => ({ ...record(entry), id }));
  }
  return Array.isArray(agents.list) ? agents.list.map(record) : [];
}

function projectScope(input: ConfiguredBuilderProjectAgentInput) {
  const managed = new Map(input.managedProjectIds.map((id) => [projectAgentId(input.slug, id), id]));
  const accounts = new Set(input.managedProjectIds.map((id) => `${input.slug}-proj-${id}`));
  for (const account of Object.keys(input.projectAccounts)) {
    if (!accounts.has(account)) throw new Error(`unmanaged project account: ${account}`);
  }
  for (const id of input.activationProjectIds) {
    if (!managed.has(projectAgentId(input.slug, id))) throw new Error(`unmanaged project activation: ${id}`);
  }
  const active = new Set<string>();
  for (const entry of input.projectAgentEntries) {
    const id = managed.get(String(entry.id));
    if (!id) throw new Error(`unmanaged project agent: ${String(entry.id)}`);
    if (!input.projectAccounts[`${input.slug}-proj-${id}`]) {
      throw new Error(`project agent account is missing: ${id}`);
    }
    active.add(id);
  }
  for (const id of input.managedProjectIds) {
    if (input.projectAccounts[`${input.slug}-proj-${id}`] && !active.has(id)) throw new Error(`project agent entry is missing: ${id}`);
  }
  return { managed, accounts, active };
}

function projectBindings(current: unknown, input: ConfiguredBuilderProjectAgentInput, replaced: ReadonlySet<string>, active: ReadonlySet<string>): unknown[] {
  const agentIds = new Set([...replaced].map((id) => projectAgentId(input.slug, id)));
  const accountIds = new Set([...replaced].map((id) => `${input.slug}-proj-${id}`));
  const channelIds = new Set(input.channels.filter((channel) => channel.scope === "project" && replaced.has(channel.projectId ?? "")).map((channel) => channel.channelId));
  const before = record(current).bindings;
  const bindings: unknown[] = Array.isArray(before) ? before : [];
  const kept = bindings.filter((binding) => {
    const entry = record(binding);
    const match = record(entry.match);
    return match.channel !== "mattermost" || !(agentIds.has(String(entry.agentId)) || accountIds.has(String(match.accountId)) || channelIds.has(String(record(match.peer).id)));
  });
  const desired = buildCustomerBindings([{ slug: input.slug, channels: input.channels, agentProjects: active }]).filter((binding) => agentIds.has(binding.agentId));
  const next = [...kept, ...desired];
  const sorted = (items: unknown[]) => JSON.stringify(items.map((item) => JSON.stringify(item)).sort());
  return sorted(next) === sorted(bindings) ? bindings : next;
}

export function configuredBuilderProjectAgentPatch(current: unknown, input: ConfiguredBuilderProjectAgentInput): ConfiguredBuilderProjectAgentPatch {
  const { managed, accounts, active } = projectScope(input);
  const roster = currentRoster(current);
  const existingAgents = new Map(roster.map((entry) => [String(entry.id), entry]));
  const existingAccounts = record(record(record(record(current).channels).mattermost).accounts);
  const activating = new Set(input.activationProjectIds.map((id) => projectAgentId(input.slug, id)));
  const entries = input.projectAgentEntries.map((entry) => {
    const existing = existingAgents.get(String(entry.id));
    return existing && !activating.has(String(entry.id)) ? existing : { ...entry, ...existing };
  });
  const desiredAgents = new Map(entries.map((entry) => [String(entry.id), entry]));
  const fullRoster = [...roster.map((entry) => desiredAgents.get(String(entry.id)) ?? entry), ...entries.filter((entry) => !existingAgents.has(String(entry.id)))];
  const replaced = new Set(input.activationProjectIds);
  const accountPatch: Record<string, unknown> = {};
  for (const id of input.managedProjectIds) {
    const accountId = `${input.slug}-proj-${id}`;
    if (!active.has(id)) {
      accountPatch[accountId] = null;
      replaced.add(id);
      continue;
    }
    const desired = record(input.projectAccounts[accountId]);
    const existing = existingAccounts[accountId];
    accountPatch[accountId] = existing && !replaced.has(id) ? existing : { ...desired, ...record(existing), botToken: desired.botToken };
    if (!existingAccounts[accountId] || !existingAgents.has(projectAgentId(input.slug, id))) replaced.add(id);
  }
  const isKeyed = record(record(current).agents).entries !== undefined;
  return {
    patch: {
      agents: customerAgentRosterPatch(current, input.slug, isKeyed ? entries : fullRoster),
      bindings: projectBindings(current, input, replaced, active),
      channels: { mattermost: { accounts: accountPatch } },
    },
    replacePaths: customerConfigReplacePaths(current, input.slug).filter((path) => path === "bindings" || [...accounts].some((id) => path.startsWith(`channels.mattermost.accounts.${id}.`))),
    retiredAgentIds: roster.filter((entry) => managed.has(String(entry.id)) && !desiredAgents.has(String(entry.id))).map((entry) => String(entry.id)),
  };
}
