import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_PATCH_DEADLINE_MS } from "@octogee/shared/types/fleet-controller";
import { applyConfigPatch, customerAgentRosterPatch, customerConfigAgentRosterReplacePaths, upsertAgentInFullAgentList, } from "./apply-config-patch.js";
export const MIGRATION_ACTIVATION_DIR = ".octogee-migration-activation";
export const MIGRATION_ACTIVATION_FILE = "activation.json";
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function activationAgentForTarget(manifestAgent, currentAgent) {
    if (!currentAgent || !hasOwn(currentAgent, "model"))
        return manifestAgent;
    return { ...manifestAgent, model: currentAgent.model };
}
function currentActivationAgent(current, agentId) {
    const agents = current?.agents;
    const entries = agents?.entries;
    if (isRecord(entries)) {
        const entry = entries[agentId];
        return isRecord(entry) ? { ...entry, id: agentId } : undefined;
    }
    const list = agents?.list;
    return Array.isArray(list)
        ? list.find((entry) => isRecord(entry) && entry.id === agentId)
        : undefined;
}
export function activationManifestTarPath(slug) {
    return path.join(MIGRATION_ACTIVATION_DIR, slug, MIGRATION_ACTIVATION_FILE);
}
function activationManifestDiskPath(openclawDir, slug) {
    return path.join(openclawDir, activationManifestTarPath(slug));
}
function expectedAgentId(slug) {
    return `octogee-${slug}-coach`;
}
function expectedAccountId(slug) {
    return `${slug}-coach`;
}
function validateManifestShape(value, slug) {
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
export async function extractOpenClawActivationManifest(configPath, slug, opts = {}) {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const agentId = expectedAgentId(slug);
    const accountId = expectedAccountId(slug);
    const entries = parsed.agents?.entries;
    const keyedAgent = isRecord(entries) && isRecord(entries[agentId])
        ? { ...entries[agentId], id: agentId }
        : undefined;
    const agent = keyedAgent ?? parsed.agents?.list?.find((entry) => isRecord(entry) && entry.id === agentId);
    const sourceAccount = parsed.channels?.mattermost?.accounts?.[accountId];
    const mattermostAccount = isRecord(sourceAccount) && opts.botToken
        ? { ...sourceAccount, botToken: opts.botToken }
        : sourceAccount;
    const bindings = (parsed.bindings ?? []).filter((binding) => isRecord(binding) && binding.agentId === agentId);
    return validateManifestShape({
        version: 1,
        slug,
        agentId,
        accountId,
        agent,
        mattermostAccount,
        bindings,
    }, slug);
}
export async function writeActivationManifest(rootDir, manifest) {
    const relPath = activationManifestTarPath(manifest.slug);
    const fullPath = path.join(rootDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, `${JSON.stringify(manifest)}\n`, "utf-8");
    return { cwd: rootDir, path: relPath };
}
export async function readActivationManifest(openclawDir, slug) {
    const manifestPath = activationManifestDiskPath(openclawDir, slug);
    const raw = await fs.readFile(manifestPath, "utf-8");
    return validateManifestShape(JSON.parse(raw), slug);
}
export async function removeActivationManifest(openclawDir, slug) {
    const manifestDir = path.join(openclawDir, MIGRATION_ACTIVATION_DIR, slug);
    await fs.rm(manifestDir, { recursive: true, force: true });
}
export async function applyOpenClawActivationManifest(manifest, opts) {
    const startedAt = Date.now();
    await applyConfigPatch({
        buildPatch: (current) => {
            const cfg = current;
            const currentBindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
            const currentAccounts = cfg.channels?.mattermost?.accounts ?? {};
            const currentAgent = currentActivationAgent(current, manifest.agentId);
            const agent = activationAgentForTarget(manifest.agent, currentAgent);
            return {
                agents: customerAgentRosterPatch(current, manifest.slug, upsertAgentInFullAgentList(current, manifest.agentId, agent)),
                bindings: [
                    ...currentBindings.filter((binding) => !(isRecord(binding) && binding.agentId === manifest.agentId)),
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
        buildReplacePaths: (current) => customerConfigAgentRosterReplacePaths(current, manifest.slug),
        logPrefix: `[import:${manifest.slug}]`,
    }, {
        rpc: opts.rpc,
        cache: opts.cache,
        signal: opts.signal,
        log: opts.log,
        totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS,
    });
    return { elapsedMs: Date.now() - startedAt };
}
