import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_PATCH_DEADLINE_MS } from "@octogee/shared/types/fleet-controller";
import { parseAgentId } from "@octogee/shared/types/identity";
import { applyConfigPatch, customerAgentRosterPatch, customerConfigAgentRosterReplacePaths, filterOutCustomerBindings, replaceCustomerAgentsInFullAgentList, staleProjectAgentAccountNulls, upsertAgentInFullAgentList, } from "./apply-config-patch.js";
import { rebindPlatformEmbeddingRefs } from "./platform-embedding-refs.js";
import { reconcileBuilderAgentEntry, reconcileCustomerAgentEntry, } from "./system-config-invariants.js";
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
    const selected = currentAgent && hasOwn(currentAgent, "model")
        ? { ...manifestAgent, model: currentAgent.model }
        : { ...manifestAgent };
    delete selected.default;
    if (currentAgent?.default === true)
        selected.default = true;
    const agent = selected;
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
function rosterAgentId(agent) {
    if (typeof agent.id !== "string" || agent.id.length === 0) {
        throw new Error("activation roster agent requires a non-empty id");
    }
    return agent.id;
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
    if (!bindings.every((binding) => {
        if (!isRecord(binding) || binding.agentId !== expectedId || !isRecord(binding.match)) {
            return false;
        }
        return binding.match.channel === "mattermost" &&
            binding.match.accountId === expectedAccount;
    })) {
        throw new Error(`[migration-activation:${slug}] activation manifest contains foreign binding scope`);
    }
    const stableBinding = {
        agentId: expectedId,
        match: { channel: "mattermost", accountId: expectedAccount },
    };
    const normalizedBindings = bindings.some((binding) => isAccountBinding(binding))
        ? bindings
        : [stableBinding, ...bindings];
    return {
        agentId: expectedId,
        accountId: expectedAccount,
        agent,
        mattermostAccount,
        bindings: normalizedBindings,
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
function mattermostBindingKey(value) {
    if (!isRecord(value) || typeof value.agentId !== "string")
        return null;
    const match = value.match;
    if (!isRecord(match) ||
        match.channel !== "mattermost" ||
        typeof match.accountId !== "string") {
        return null;
    }
    if (match.peer === undefined) {
        return `${match.accountId}\u0000${value.agentId}\u0000account`;
    }
    if (!isRecord(match.peer) ||
        typeof match.peer.kind !== "string" ||
        typeof match.peer.id !== "string") {
        return `${match.accountId}\u0000${value.agentId}\u0000malformed`;
    }
    return `${match.accountId}\u0000${value.agentId}\u0000${match.peer.kind}\u0000${match.peer.id}`;
}
function isAccountBinding(value) {
    if (!isRecord(value) || !isRecord(value.match))
        return false;
    return value.match.channel === "mattermost" &&
        typeof value.match.accountId === "string" &&
        value.match.peer === undefined;
}
function accountBindingsNeedingActivation(current, desired) {
    const desiredAccountIds = new Set(desired.flatMap((binding) => {
        if (!isAccountBinding(binding))
            return [];
        return [binding.match.accountId];
    }));
    const existing = new Set(current.flatMap((binding) => {
        const key = mattermostBindingKey(binding);
        return key ? [key] : [];
    }));
    const desiredKeys = new Set(desired.flatMap((binding) => {
        const key = mattermostBindingKey(binding);
        return key ? [key] : [];
    }));
    const affected = new Set();
    for (const binding of desired) {
        if (!isAccountBinding(binding))
            continue;
        const key = mattermostBindingKey(binding);
        const accountId = binding.match.accountId;
        if (!existing.has(key))
            affected.add(accountId);
    }
    for (const binding of current) {
        const key = mattermostBindingKey(binding);
        if (!key)
            continue;
        const accountId = key.slice(0, key.indexOf("\u0000"));
        if (desiredAccountIds.has(accountId) && !desiredKeys.has(key)) {
            affected.add(accountId);
        }
    }
    return [...affected].sort();
}
/**
 * Every agent id the activation installs. The caller compares it against the
 * target's live roster: residue the manifest does not carry has to leave by
 * `agents.delete` before the patch, because 2026.7.2 refuses a config write
 * that drops roster entries.
 */
export function activationManifestAgentIds(manifest) {
    return manifestAgents(manifest).map((entry) => entry.agentId);
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
    const authInheritanceAnchor = opts.authInheritanceAnchor;
    const reconcileAgent = opts.gatewayClass === "builder"
        ? reconcileBuilderAgentEntry
        : reconcileCustomerAgentEntry;
    if (authInheritanceAnchor &&
        rosterAgentId(authInheritanceAnchor.agent) !== authInheritanceAnchor.agentId) {
        throw new Error("activation auth inheritance anchor id mismatch");
    }
    const normalizedAuthInheritanceAnchor = authInheritanceAnchor && {
        ...authInheritanceAnchor,
        agent: reconcileAgent(authInheritanceAnchor.agentId, authInheritanceAnchor.agent),
    };
    const startedAt = Date.now();
    let routingActivationRequired = false;
    let restartExistingAccountIds = [];
    const configPatch = await applyConfigPatch({
        buildPatch: (current) => {
            const cfg = current;
            const currentBindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
            const agents = current?.agents;
            const targetUsesKeyedEntries = isRecord(agents?.entries);
            const activationAgents = manifestAgents(manifest).map((entry) => ({
                ...entry,
                agent: reconcileAgent(entry.agentId, activationAgentForTarget(entry.agent, currentActivationAgent(current, entry.agentId), targetUsesKeyedEntries)),
            }));
            const currentAccounts = current?.channels?.mattermost?.accounts ?? {};
            const missingAccountIds = accountBindingsNeedingActivation(currentBindings, activationAgents.flatMap((entry) => entry.bindings));
            restartExistingAccountIds = missingAccountIds
                .filter((accountId) => isRecord(currentAccounts[accountId]))
                .sort();
            if (missingAccountIds.length > 0 && !routingActivationRequired) {
                opts.onRoutingActivationRequired?.(missingAccountIds);
                routingActivationRequired = true;
            }
            const rosterAgents = normalizedAuthInheritanceAnchor
                ? [normalizedAuthInheritanceAnchor.agent, ...activationAgents.map((entry) => entry.agent)]
                : activationAgents.map((entry) => entry.agent);
            const nextAgents = targetUsesKeyedEntries
                ? rosterAgents
                : rosterAgents.reduce((agentList, agent) => upsertAgentInFullAgentList({ agents: { list: agentList } }, rosterAgentId(agent), agent), replaceCustomerAgentsInFullAgentList(current, manifest.slug, []));
            const rosterPatch = customerAgentRosterPatch(current, manifest.slug, rebindPlatformEmbeddingRefs(nextAgents));
            return {
                // openclaw rejects a multi-agent roster that declares no ownership.
                agents: {
                    ...rosterPatch,
                    ownership: "explicit",
                    ...(normalizedAuthInheritanceAnchor
                        ? {
                            defaults: {
                                authInheritance: { agentId: normalizedAuthInheritanceAnchor.agentId },
                            },
                        }
                        : {}),
                },
                bindings: [
                    ...filterOutCustomerBindings(currentBindings, manifest.slug),
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
    return {
        elapsedMs: Date.now() - startedAt,
        routingActivationRequired,
        restartExistingAccountIds,
        configNoop: configPatch.noop === true,
    };
}
