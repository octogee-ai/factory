import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_PATCH_DEADLINE_MS } from "@octogee/shared/types/fleet-controller";
import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import { parseAgentId } from "@octogee/shared/types/identity";
import { applyConfigPatch, customerAgentRosterPatch, customerConfigAgentRosterReplacePaths, replaceCustomerAgentsInFullAgentList, staleProjectAgentAccountNulls, upsertAgentInFullAgentList, } from "./apply-config-patch.js";
import { rebindPlatformEmbeddingRefs } from "./platform-embedding-refs.js";
export const MIGRATION_ACTIVATION_DIR = ".octogee-migration-activation";
export const MIGRATION_ACTIVATION_FILE = "activation.json";
export class LegacyActivationManifestFingerprintError extends Error {
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function activationAgentForTarget(manifestAgent, currentAgent, targetUsesKeyedEntries) {
    const agent = currentAgent && hasOwn(currentAgent, "model")
        ? { ...manifestAgent, model: currentAgent.model }
        : manifestAgent;
    if (targetUsesKeyedEntries || !hasOwn(agent, "memory"))
        return agent;
    const memory = agent.memory;
    if (!isRecord(memory) || !isRecord(memory.search)) {
        throw new Error("stable target cannot represent beta agent memory without memory.search");
    }
    const unsupportedMemoryFields = Object.keys(memory).filter((key) => key !== "search");
    if (unsupportedMemoryFields.length > 0) {
        throw new Error(`stable target cannot represent beta agent memory fields: ${unsupportedMemoryFields.join(", ")}`);
    }
    const stableAgent = { ...agent };
    delete stableAgent.memory;
    return { ...stableAgent, memorySearch: memory.search };
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
function expectedProjectAccountId(slug, agentId) {
    const parsed = parseAgentId(agentId);
    if (parsed.kind !== "project" || parsed.username !== slug)
        return null;
    return `${slug}-proj-${parsed.project}`;
}
function validateManifestAgent(value, slug, expectedId, expectedAccount) {
    const agent = value.agent;
    const mattermostAccount = value.mattermostAccount;
    const bindings = value.bindings;
    if (value.agentId !== expectedId || value.accountId !== expectedAccount) {
        throw new Error(`[migration-activation:${slug}] activation manifest id mismatch`);
    }
    if (!isRecord(agent) || agent.id !== expectedId) {
        throw new Error(`[migration-activation:${slug}] activation manifest agent missing or mismatched`);
    }
    if (!isRecord(mattermostAccount)
        || typeof mattermostAccount.botToken !== "string"
        || mattermostAccount.botToken.length === 0) {
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
function manifestAppliedFingerprint(value, slug, legacyAppliedFingerprint) {
    const appliedFingerprint = value.version === 2
        ? value.appliedFingerprint
        : legacyAppliedFingerprint;
    if (typeof appliedFingerprint === "string" && appliedFingerprint.length > 0) {
        return appliedFingerprint;
    }
    if (value.version === 1) {
        throw new LegacyActivationManifestFingerprintError(`[migration-activation:${slug}] legacy activation manifest requires target fingerprint`);
    }
    throw new Error(`[migration-activation:${slug}] activation manifest version/slug mismatch`);
}
function validateManifestShape(value, slug, opts = {}) {
    if (!isRecord(value)) {
        throw new Error(`[migration-activation:${slug}] activation manifest is not an object`);
    }
    const agentId = expectedAgentId(slug);
    const accountId = expectedAccountId(slug);
    if (value.slug !== slug || (value.version !== 1 && value.version !== 2)) {
        throw new Error(`[migration-activation:${slug}] activation manifest version/slug mismatch`);
    }
    const appliedFingerprint = manifestAppliedFingerprint(value, slug, opts.legacyAppliedFingerprint);
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
    const ids = new Set();
    const accounts = new Set();
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
function sourceAgents(parsed) {
    const entries = parsed.agents?.entries;
    if (isRecord(entries)) {
        return Object.entries(entries)
            .filter((entry) => isRecord(entry[1]))
            .map(([id, agent]) => ({ ...agent, id }));
    }
    const list = parsed.agents?.list;
    return Array.isArray(list) ? list.filter(isRecord) : [];
}
async function sourceManifestAgent(input) {
    let token;
    if (input.opts.resolveBotToken) {
        token = await input.opts.resolveBotToken(input.accountId);
    }
    else if (input.isWorkspace && input.opts.botToken !== undefined) {
        token = input.opts.botToken;
    }
    else if (isRecord(input.sourceAccount)) {
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
export async function extractOpenClawActivationManifest(configPath, slug, opts) {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
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
    const projectAgents = await Promise.all(agents
        .filter((agent) => typeof agent.id === "string" && expectedProjectAccountId(slug, agent.id))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
        .map(async (agent) => {
        const projectAccountId = expectedProjectAccountId(slug, agent.id);
        return sourceManifestAgent({
            agent,
            accountId: projectAccountId,
            bindings: bindings.filter((binding) => isRecord(binding) && binding.agentId === agent.id),
            opts,
            sourceAccount: parsed.channels?.mattermost?.accounts?.[projectAccountId],
            isWorkspace: false,
        });
    }));
    return validateManifestShape({
        version: 2,
        slug,
        appliedFingerprint: opts.appliedFingerprint,
        ...workspace,
        projectAgents,
    }, slug);
}
function manifestAgents(manifest) {
    const { projectAgents, ...workspace } = manifest;
    return [workspace, ...projectAgents];
}
export async function writeActivationManifest(rootDir, manifest) {
    const relPath = activationManifestTarPath(manifest.slug);
    const fullPath = path.join(rootDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, `${JSON.stringify(manifest)}\n`, "utf-8");
    return { cwd: rootDir, path: relPath };
}
export async function readActivationManifest(openclawDir, slug, opts = {}) {
    const manifestPath = activationManifestDiskPath(openclawDir, slug);
    const raw = await fs.readFile(manifestPath, "utf-8");
    return validateManifestShape(JSON.parse(raw), slug, opts);
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
            const agents = current?.agents;
            const targetUsesKeyedEntries = isRecord(agents?.entries);
            const activationAgents = manifestAgents(manifest).map((entry) => ({
                ...entry,
                agent: activationAgentForTarget(entry.agent, currentActivationAgent(current, entry.agentId), targetUsesKeyedEntries),
            }));
            const nextAgents = targetUsesKeyedEntries
                ? activationAgents.map((entry) => entry.agent)
                : activationAgents.reduce((agentList, entry) => upsertAgentInFullAgentList({ agents: { list: agentList } }, entry.agentId, entry.agent), replaceCustomerAgentsInFullAgentList(current, manifest.slug, []));
            return {
                agents: customerAgentRosterPatch(current, manifest.slug, rebindPlatformEmbeddingRefs(nextAgents)),
                bindings: [
                    ...currentBindings.filter((binding) => !(isRecord(binding)
                        && typeof binding.agentId === "string"
                        && agentIdBelongsToSlug(binding.agentId, manifest.slug))),
                    ...activationAgents.flatMap((entry) => entry.bindings),
                ],
                channels: {
                    mattermost: {
                        accounts: {
                            ...staleProjectAgentAccountNulls(current, manifest.slug, activationAgents.map((entry) => entry.accountId)),
                            ...Object.fromEntries(activationAgents.map((entry) => [entry.accountId, entry.mattermostAccount])),
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
