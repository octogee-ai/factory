import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_PATCH_DEADLINE_MS } from "../../shared/types/fleet-controller.js";
import {
  applyConfigPatch,
  customerConfigFullAgentListReplacePaths,
  type ConfigCache,
} from "./apply-config-patch.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";

export const MIGRATION_ACTIVATION_DIR = ".octogee-migration-activation";
export const MIGRATION_ACTIVATION_FILE = "activation.json";

export interface MigrationActivationManifest {
  version: 1;
  slug: string;
  agentId: string;
  accountId: string;
  agent: Record<string, unknown>;
  mattermostAccount: Record<string, unknown>;
  bindings: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function validateManifestShape(
  value: unknown,
  slug: string,
): MigrationActivationManifest {
  if (!isRecord(value)) {
    throw new Error(`[migration-activation:${slug}] activation manifest is not an object`);
  }
  const agentId = expectedAgentId(slug);
  const accountId = expectedAccountId(slug);
  const agent = value.agent;
  const mattermostAccount = value.mattermostAccount;
  const bindings = value.bindings;
  if (value.version !== 1 || value.slug !== slug) {
    throw new Error(`[migration-activation:${slug}] activation manifest version/slug mismatch`);
  }
  if (value.agentId !== agentId || value.accountId !== accountId) {
    throw new Error(`[migration-activation:${slug}] activation manifest id mismatch`);
  }
  if (!isRecord(agent) || agent.id !== agentId) {
    throw new Error(`[migration-activation:${slug}] activation manifest agent missing or mismatched`);
  }
  if (!isRecord(mattermostAccount) || typeof mattermostAccount.botToken !== "string" || mattermostAccount.botToken.length === 0) {
    throw new Error(`[migration-activation:${slug}] activation manifest mattermost account is missing botToken`);
  }
  if (!Array.isArray(bindings) || bindings.length === 0) {
    throw new Error(`[migration-activation:${slug}] activation manifest has no channel bindings`);
  }
  if (!bindings.every((binding) => isRecord(binding) && binding.agentId === agentId)) {
    throw new Error(`[migration-activation:${slug}] activation manifest contains binding for another agent`);
  }
  return {
    version: 1,
    slug,
    agentId,
    accountId,
    agent,
    mattermostAccount,
    bindings,
  };
}

export async function extractOpenClawActivationManifest(
  configPath: string,
  slug: string,
): Promise<MigrationActivationManifest> {
  const raw = await fs.readFile(configPath, "utf-8");
  const parsed = JSON.parse(raw) as {
    agents?: { list?: unknown[] };
    channels?: { mattermost?: { accounts?: Record<string, unknown> } };
    bindings?: unknown[];
  };
  const agentId = expectedAgentId(slug);
  const accountId = expectedAccountId(slug);
  const agent = parsed.agents?.list?.find((entry) => isRecord(entry) && entry.id === agentId);
  const mattermostAccount = parsed.channels?.mattermost?.accounts?.[accountId];
  const bindings = (parsed.bindings ?? []).filter(
    (binding) => isRecord(binding) && binding.agentId === agentId,
  );
  return validateManifestShape(
    {
      version: 1,
      slug,
      agentId,
      accountId,
      agent,
      mattermostAccount,
      bindings,
    },
    slug,
  );
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
): Promise<MigrationActivationManifest> {
  const manifestPath = activationManifestDiskPath(openclawDir, slug);
  const raw = await fs.readFile(manifestPath, "utf-8");
  return validateManifestShape(JSON.parse(raw), slug);
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
          agents?: { list?: unknown[] };
          channels?: { mattermost?: { accounts?: Record<string, unknown> } };
          bindings?: unknown[];
        };
        const currentAgents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
        const currentBindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
        const currentAccounts = cfg.channels?.mattermost?.accounts ?? {};
        return {
          agents: {
            list: [
              ...currentAgents.filter(
                (entry) => !(isRecord(entry) && entry.id === manifest.agentId),
              ),
              manifest.agent,
            ],
          },
          bindings: [
            ...currentBindings.filter(
              (binding) => !(isRecord(binding) && binding.agentId === manifest.agentId),
            ),
            ...manifest.bindings,
          ],
          channels: {
            mattermost: {
              accounts: {
                ...currentAccounts,
                [manifest.accountId]: manifest.mattermostAccount,
              },
            },
          },
        };
      },
      // Rebuilding the agent's bindings can shrink the array (stale entries dropped), and
      // importing over residue merges an account fragment whose arrays can shrink too — the
      // gateway's destructive-array guard requires both confirmed.
      buildReplacePaths: (current) => customerConfigFullAgentListReplacePaths(current, manifest.slug),
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
