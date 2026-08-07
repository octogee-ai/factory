import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_PATCH_DEADLINE_MS } from "@octogee/shared/types/fleet-controller";
import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import { parseAgentId } from "@octogee/shared/types/identity";
import {
  applyConfigPatch,
  customerAgentRosterPatch,
  customerConfigAgentRosterReplacePaths,
  replaceCustomerAgentsInFullAgentList,
  staleProjectAgentAccountNulls,
  upsertAgentInFullAgentList,
  type ConfigCache,
} from "./apply-config-patch.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";
import { rebindPlatformEmbeddingRefs } from "./platform-embedding-refs.js";

export const MIGRATION_ACTIVATION_DIR = ".octogee-migration-activation";
export const MIGRATION_ACTIVATION_FILE = "activation.json";

export interface MigrationActivationManifestProjectAgent {
  agentId: string;
  accountId: string;
  agent: Record<string, unknown>;
  mattermostAccount: Record<string, unknown>;
  bindings: unknown[];
}

export interface MigrationActivationManifest {
  version: 2;
  slug: string;
  appliedFingerprint: string;
  agentId: string;
  accountId: string;
  agent: Record<string, unknown>;
  mattermostAccount: Record<string, unknown>;
  bindings: unknown[];
  projectAgents: MigrationActivationManifestProjectAgent[];
}

export class LegacyActivationManifestFingerprintError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function activationAgentForTarget(
  manifestAgent: Record<string, unknown>,
  currentAgent: Record<string, unknown> | undefined,
  targetUsesKeyedEntries: boolean,
): Record<string, unknown> {
  const agent = currentAgent && hasOwn(currentAgent, "model")
    ? { ...manifestAgent, model: currentAgent.model }
    : manifestAgent;
  if (targetUsesKeyedEntries || !hasOwn(agent, "memory")) return agent;

  const memory = agent.memory;
  if (!isRecord(memory) || !isRecord(memory.search)) {
    throw new Error("stable target cannot represent beta agent memory without memory.search");
  }
  const unsupportedMemoryFields = Object.keys(memory).filter((key) => key !== "search");
  if (unsupportedMemoryFields.length > 0) {
    throw new Error(
      `stable target cannot represent beta agent memory fields: ${unsupportedMemoryFields.join(", ")}`,
    );
  }
  const stableAgent = { ...agent };
  delete stableAgent.memory;
  return { ...stableAgent, memorySearch: memory.search };
}

function currentActivationAgent(
  current: unknown,
  agentId: string,
): Record<string, unknown> | undefined {
  const agents = (current as { agents?: Record<string, unknown> } | undefined)?.agents;
  const entries = agents?.entries;
  if (isRecord(entries)) {
    const entry = entries[agentId];
    return isRecord(entry) ? { ...entry, id: agentId } : undefined;
  }
  const list = agents?.list;
  return Array.isArray(list)
    ? list.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.id === agentId)
    : undefined;
}

export function activationManifestTarPath(slug: string): string {
  return path.join(MIGRATION_ACTIVATION_DIR, slug, MIGRATION_ACTIVATION_FILE);
}

function activationManifestDiskPath(openclawDir: string, slug: string): string {
  return path.join(openclawDir, activationManifestTarPath(slug));
}

function expectedAgentId(slug: string): string {
  return `octogee-${slug}-coach`;
}

function expectedAccountId(slug: string): string {
  return `${slug}-coach`;
}

function expectedProjectAccountId(slug: string, agentId: string): string | null {
  const parsed = parseAgentId(agentId);
  if (parsed.kind !== "project" || parsed.username !== slug) return null;
  return `${slug}-proj-${parsed.project}`;
}

function validateManifestAgent(
  value: Record<string, unknown>,
  slug: string,
  expectedId: string,
  expectedAccount: string,
): MigrationActivationManifestProjectAgent {
  const agent = value.agent;
  const mattermostAccount = value.mattermostAccount;
  const bindings = value.bindings;
  if (value.agentId !== expectedId || value.accountId !== expectedAccount) {
    throw new Error(`[migration-activation:${slug}] activation manifest id mismatch`);
  }
  if (!isRecord(agent) || agent.id !== expectedId) {
    throw new Error(`[migration-activation:${slug}] activation manifest agent missing or mismatched`);
  }
  if (
    !isRecord(mattermostAccount)
    || typeof mattermostAccount.botToken !== "string"
    || mattermostAccount.botToken.length === 0
  ) {
    throw new Error(`[migration-activation:${slug}] activation manifest mattermost account is missing botToken`);
  }
  if (!Array.isArray(bindings) || bindings.length === 0) {
    throw new Error(`[migration-activation:${slug}] activation manifest has no channel bindings`);
  }
  if (!bindings.every((binding) => isRecord(binding) && binding.agentId === expectedId)) {
    throw new Error(`[migration-activation:${slug}] activation manifest contains binding for another agent`);
  }
  return {
    agentId: expectedId,
    accountId: expectedAccount,
    agent,
    mattermostAccount,
    bindings,
  };
}

function manifestAppliedFingerprint(
  value: Record<string, unknown>,
  slug: string,
  legacyAppliedFingerprint: string | undefined,
): string {
  const appliedFingerprint = value.version === 2
    ? value.appliedFingerprint
    : legacyAppliedFingerprint;
  if (typeof appliedFingerprint === "string" && appliedFingerprint.length > 0) {
    return appliedFingerprint;
  }
  if (value.version === 1) {
    throw new LegacyActivationManifestFingerprintError(
      `[migration-activation:${slug}] legacy activation manifest requires target fingerprint`,
    );
  }
  throw new Error(`[migration-activation:${slug}] activation manifest version/slug mismatch`);
}

function validateManifestShape(
  value: unknown,
  slug: string,
  opts: { legacyAppliedFingerprint?: string } = {},
): MigrationActivationManifest {
  if (!isRecord(value)) {
    throw new Error(`[migration-activation:${slug}] activation manifest is not an object`);
  }
  const agentId = expectedAgentId(slug);
  const accountId = expectedAccountId(slug);
  if (value.slug !== slug || (value.version !== 1 && value.version !== 2)) {
    throw new Error(`[migration-activation:${slug}] activation manifest version/slug mismatch`);
  }
  const appliedFingerprint = manifestAppliedFingerprint(
    value,
    slug,
    opts.legacyAppliedFingerprint,
  );
  const workspace = validateManifestAgent(value, slug, agentId, accountId);
  const rawProjects = value.projectAgents;
  if (rawProjects !== undefined && !Array.isArray(rawProjects)) {
    throw new Error(`[migration-activation:${slug}] activation manifest project agents are invalid`);
  }
  const projectAgents = (rawProjects ?? []).map((project) => {
    if (!isRecord(project) || typeof project.agentId !== "string") {
      throw new Error(`[migration-activation:${slug}] activation manifest project agent is invalid`);
    }
    const projectAccountId = expectedProjectAccountId(slug, project.agentId);
    if (!projectAccountId) {
      throw new Error(`[migration-activation:${slug}] activation manifest project agent id mismatch`);
    }
    return validateManifestAgent(project, slug, project.agentId, projectAccountId);
  });
  const ids = new Set<string>();
  const accounts = new Set<string>();
  for (const entry of [workspace, ...projectAgents]) {
    if (ids.has(entry.agentId) || accounts.has(entry.accountId)) {
      throw new Error(`[migration-activation:${slug}] activation manifest contains duplicate agent/account`);
    }
    ids.add(entry.agentId);
    accounts.add(entry.accountId);
  }
  return {
    version: 2,
    slug,
    appliedFingerprint,
    ...workspace,
    projectAgents,
  };
}

function sourceAgents(parsed: {
  agents?: { list?: unknown[]; entries?: Record<string, unknown> };
}): Record<string, unknown>[] {
  const entries = parsed.agents?.entries;
  if (isRecord(entries)) {
    return Object.entries(entries)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .map(([id, agent]) => ({ ...agent, id }));
  }
  const list = parsed.agents?.list;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

interface SourceManifestAgentInput {
  agent: Record<string, unknown> | undefined;
  accountId: string;
  bindings: unknown[];
  opts: {
    botToken?: string;
    resolveBotToken?: (accountId: string) => Promise<string | undefined>;
  };
  sourceAccount: unknown;
  isWorkspace: boolean;
}

async function sourceManifestAgent(
  input: SourceManifestAgentInput,
): Promise<Record<string, unknown>> {
  let token: unknown;
  if (input.opts.resolveBotToken) {
    token = await input.opts.resolveBotToken(input.accountId);
  } else if (input.isWorkspace && input.opts.botToken !== undefined) {
    token = input.opts.botToken;
  } else if (isRecord(input.sourceAccount)) {
    token = input.sourceAccount.botToken;
  }
  return {
    agentId: input.agent?.id,
    accountId: input.accountId,
    agent: input.agent,
    mattermostAccount: isRecord(input.sourceAccount)
      ? { ...input.sourceAccount, botToken: token }
      : input.sourceAccount,
    bindings: input.bindings,
  };
}

export async function extractOpenClawActivationManifest(
  configPath: string,
  slug: string,
  opts: {
    appliedFingerprint: string;
    botToken?: string;
    resolveBotToken?: (accountId: string) => Promise<string | undefined>;
  },
): Promise<MigrationActivationManifest> {
  const raw = await fs.readFile(configPath, "utf-8");
  const parsed = JSON.parse(raw) as {
    agents?: { list?: unknown[]; entries?: Record<string, unknown> };
    channels?: { mattermost?: { accounts?: Record<string, unknown> } };
    bindings?: unknown[];
  };
  const agentId = expectedAgentId(slug);
  const accountId = expectedAccountId(slug);
  const agents = sourceAgents(parsed);
  const bindings = Array.isArray(parsed.bindings) ? parsed.bindings : [];
  const workspace = await sourceManifestAgent({
    agent: agents.find((agent) => agent.id === agentId),
    accountId,
    bindings: bindings.filter((binding) => isRecord(binding) && binding.agentId === agentId),
    opts,
    sourceAccount: parsed.channels?.mattermost?.accounts?.[accountId],
    isWorkspace: true,
  });
  const projectAgents = await Promise.all(
    agents
      .filter((agent) => typeof agent.id === "string" && expectedProjectAccountId(slug, agent.id))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
      .map(async (agent) => {
        const projectAccountId = expectedProjectAccountId(slug, agent.id as string)!;
        return sourceManifestAgent({
          agent,
          accountId: projectAccountId,
          bindings: bindings.filter((binding) => isRecord(binding) && binding.agentId === agent.id),
          opts,
          sourceAccount: parsed.channels?.mattermost?.accounts?.[projectAccountId],
          isWorkspace: false,
        });
      }),
  );
  return validateManifestShape(
    {
      version: 2,
      slug,
      appliedFingerprint: opts.appliedFingerprint,
      ...workspace,
      projectAgents,
    },
    slug,
  );
}

function manifestAgents(
  manifest: MigrationActivationManifest,
): MigrationActivationManifestProjectAgent[] {
  const { projectAgents, ...workspace } = manifest;
  return [workspace, ...projectAgents];
}

/**
 * Every agent id the activation installs. The caller compares it against the
 * target's live roster: residue the manifest does not carry has to leave by
 * `agents.delete` before the patch, because 2026.7.2 refuses a config write
 * that drops roster entries.
 */
export function activationManifestAgentIds(
  manifest: MigrationActivationManifest,
): string[] {
  return manifestAgents(manifest).map((entry) => entry.agentId);
}

export async function writeActivationManifest(
  rootDir: string,
  manifest: MigrationActivationManifest,
): Promise<{ cwd: string; path: string }> {
  const relPath = activationManifestTarPath(manifest.slug);
  const fullPath = path.join(rootDir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, `${JSON.stringify(manifest)}\n`, "utf-8");
  return { cwd: rootDir, path: relPath };
}

export async function readActivationManifest(
  openclawDir: string,
  slug: string,
  opts: { legacyAppliedFingerprint?: string } = {},
): Promise<MigrationActivationManifest> {
  const manifestPath = activationManifestDiskPath(openclawDir, slug);
  const raw = await fs.readFile(manifestPath, "utf-8");
  return validateManifestShape(JSON.parse(raw), slug, opts);
}

export async function removeActivationManifest(
  openclawDir: string,
  slug: string,
): Promise<void> {
  const manifestDir = path.join(openclawDir, MIGRATION_ACTIVATION_DIR, slug);
  await fs.rm(manifestDir, { recursive: true, force: true });
}

export async function applyOpenClawActivationManifest(
  manifest: MigrationActivationManifest,
  opts: {
    rpc: GatewayRpcClient;
    cache?: ConfigCache;
    signal?: AbortSignal;
    log: (msg: string) => void;
  },
): Promise<{ elapsedMs: number }> {
  const startedAt = Date.now();
  await applyConfigPatch(
    {
      buildPatch: (current) => {
        const cfg = current as {
          bindings?: unknown[];
        };
        const currentBindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
        const agents = (current as { agents?: Record<string, unknown> } | undefined)?.agents;
        const targetUsesKeyedEntries = isRecord(agents?.entries);
        const activationAgents = manifestAgents(manifest).map((entry) => ({
          ...entry,
          agent: activationAgentForTarget(
            entry.agent,
            currentActivationAgent(current, entry.agentId),
            targetUsesKeyedEntries,
          ),
        }));
        const nextAgents = targetUsesKeyedEntries
          ? activationAgents.map((entry) => entry.agent)
          : activationAgents.reduce(
            (agentList, entry) => upsertAgentInFullAgentList(
              { agents: { list: agentList } },
              entry.agentId,
              entry.agent,
            ),
            replaceCustomerAgentsInFullAgentList(current, manifest.slug, []),
          );
        return {
          agents: customerAgentRosterPatch(
            current,
            manifest.slug,
            rebindPlatformEmbeddingRefs(nextAgents),
          ),
          bindings: [
            ...currentBindings.filter(
              (binding) => !(
                isRecord(binding)
                && typeof binding.agentId === "string"
                && agentIdBelongsToSlug(binding.agentId, manifest.slug)
              ),
            ),
            ...activationAgents.flatMap((entry) => entry.bindings),
          ],
          channels: {
            mattermost: {
              accounts: {
                ...staleProjectAgentAccountNulls(
                  current,
                  manifest.slug,
                  activationAgents.map((entry) => entry.accountId),
                ),
                ...Object.fromEntries(
                  activationAgents.map((entry) => [entry.accountId, entry.mattermostAccount]),
                ),
              },
            },
          },
        };
      },
      // Rebuilding the agent's bindings can shrink the array (stale entries dropped), and
      // importing over residue merges an account fragment whose arrays can shrink too — the
      // gateway's destructive-array guard requires both confirmed.
      buildReplacePaths: (current) => customerConfigAgentRosterReplacePaths(current, manifest.slug),
      logPrefix: `[import:${manifest.slug}]`,
    },
    {
      rpc: opts.rpc,
      cache: opts.cache,
      signal: opts.signal,
      log: opts.log,
      totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS,
    },
  );
  return { elapsedMs: Date.now() - startedAt };
}
