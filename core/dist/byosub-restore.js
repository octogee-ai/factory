import * as fs from "fs";
import * as path from "path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readPostgresAgentAnchor, writeAgentStore } from "./agent-postgres.js";
import { buildCodexAuthProfilesStore, buildClaudeCliAuthProfilesStore, buildClaudeCliNativeCredentialsJson, CLAUDE_CLI_DEFAULT_PROFILE_ID, OPENAI_CODEX_DEFAULT_PROFILE_ID, } from "./model-credential-materializer.js";
import { deleteAuthProfileStore, readAuthProfileState, readAuthProfileStore, SHARED_MAIN_AGENT_ID, writeAuthProfileStore, } from "./auth-profile-store.js";
import { deriveCodexAuthHealth } from "./codex-auth-health.js";
import { agentModelTokenProfileEntry, openAiBrokerProfileEntry, openRouterBrokerProfileEntry, vertexBrokerProfileEntry, } from "./agent-model-token-materializer.js";
import { configuredPlatformVertexBaseUrl } from "./platform-vertex-env.js";
/**
 * Every rostered agent id, from either roster form.
 *
 * 2026.7.2 rewrites `agents.list` into keyed `agents.entries` at pre-boot, so on
 * a current pod the list form is simply absent. Reading only `.list` there
 * returns [] and turns every caller into a silent no-op — the model-ready boot
 * sweep, git-identity hydration, byosub syncback and the broker-profile retry
 * all quietly stop working. Entries win when both are present: the migration
 * leaves the pre-migration list behind, so it is the stale copy.
 */
export function agentIdsFromConfig(config) {
    const agents = config?.agents;
    const entries = agents?.entries;
    if (entries && typeof entries === "object" && !Array.isArray(entries)) {
        // A nulled key is how a removal deletes an agent in openclaw's merge-patch;
        // reporting it would hand callers an agent that no longer exists.
        return Object.entries(entries)
            .filter(([id, entry]) => id.length > 0 && entry !== null && entry !== undefined)
            .map(([id]) => id);
    }
    const list = agents?.list;
    if (!Array.isArray(list))
        return [];
    return list
        .map((a) => a && typeof a === "object" ? a.id : undefined)
        .filter((id) => typeof id === "string" && id.length > 0);
}
const SAFE_AGENT_ID = /^[a-z0-9-]{1,64}$/;
export function isSafeAgentId(agentId) {
    return typeof agentId === "string" && SAFE_AGENT_ID.test(agentId);
}
export function codexHomeDir(openclawDir, agentId) {
    return path.join(openclawDir, "agents", agentId, "agent", "codex-home");
}
export function codexAuthJsonPath(openclawDir, agentId) {
    return path.join(codexHomeDir(openclawDir, agentId), "auth.json");
}
export function claudeCliNativeCredentialsPath(homeDir) {
    return path.join(homeDir, ".claude", ".credentials.json");
}
export function codexStagingHomeDir(openclawDir, agentId) {
    return path.join(openclawDir, "agents", agentId, "agent", "codex-home.staging");
}
export function codexStagingAuthJsonPath(openclawDir, agentId) {
    return path.join(codexStagingHomeDir(openclawDir, agentId), "auth.json");
}
export function codexAgentDir(openclawDir, agentId) {
    return path.join(openclawDir, "agents", agentId, "agent");
}
export function sharedAuthAgentDir(openclawDir) {
    return codexAgentDir(openclawDir, SHARED_MAIN_AGENT_ID);
}
const SUBSCRIPTION_PROFILE_IDS = {
    openai: OPENAI_CODEX_DEFAULT_PROFILE_ID,
    anthropic: CLAUDE_CLI_DEFAULT_PROFILE_ID,
};
export async function removeSubscriptionProfiles(agentDir, providers) {
    const store = await readAuthProfileStore(agentDir);
    const profiles = store?.profiles;
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles))
        return false;
    const next = { ...profiles };
    let removed = false;
    for (const provider of providers) {
        const profileId = SUBSCRIPTION_PROFILE_IDS[provider];
        if (Object.prototype.hasOwnProperty.call(next, profileId)) {
            delete next[profileId];
            removed = true;
        }
    }
    if (!removed)
        return false;
    if (Object.keys(next).length === 0) {
        await deleteAuthProfileStore(agentDir);
    }
    else {
        await writeAuthProfileStore(agentDir, { ...store, profiles: next });
    }
    return true;
}
export function codexAuthStatePath(openclawDir, agentId) {
    return path.join(codexAgentDir(openclawDir, agentId), "auth-state.json");
}
const CANONICAL_AGENT_AUTH_PROFILE_IDS = new Set([
    "anthropic:default",
    "platform-openrouter:default",
    "platform-openai:default",
    "platform-vertex:default",
]);
const SESSION_RUNTIME_STATE_FIELDS = [
    "providerOverride",
    "modelOverride",
    "modelOverrideSource",
    "modelOverrideRouteResolution",
    "modelOverrideFallbackOriginProvider",
    "modelOverrideFallbackOriginModel",
    "modelFallback",
    "authProfileOverride",
    "authProfileOverrideSource",
    "authProfileOverrideCompactionCount",
    "liveModelSwitchPending",
    "modelProvider",
    "model",
    "modelSelectionLocked",
    "agentHarnessId",
    "agentRuntimeOverride",
    "fallbackNotice",
    "contextTokens",
    "systemPromptReport",
    "cliSessionIds",
    "cliSessionBindings",
    "acpSessionBinding",
    "acp",
    "claudeCliSessionId",
    "pluginOwnerId",
    "pluginExtensions",
    "initializationPending",
    "spawnedCwd",
    "execHost",
    "execSecurity",
    "execAsk",
    "execNode",
    "execCwd",
    "elevatedLevel",
    "toolOverrides",
];
function removeIfPresent(targetPath) {
    if (!fs.existsSync(targetPath))
        return false;
    fs.rmSync(targetPath, { force: true });
    return true;
}
function removeDirIfPresent(targetPath) {
    if (!fs.existsSync(targetPath))
        return false;
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
}
async function scrubOauthProfiles(agentDir, agentId) {
    const store = await readAuthProfileStore(agentDir);
    const current = store && typeof store === "object" && !Array.isArray(store)
        ? store
        : {};
    const profiles = {
        "anthropic:default": agentModelTokenProfileEntry(agentId),
        "platform-openrouter:default": openRouterBrokerProfileEntry(agentId),
        "platform-openai:default": openAiBrokerProfileEntry(agentId),
        ...(configuredPlatformVertexBaseUrl()
            ? { "platform-vertex:default": vertexBrokerProfileEntry(agentId) }
            : {}),
    };
    if (JSON.stringify(current.profiles) === JSON.stringify(profiles)) {
        fs.chmodSync(agentDir, 0o700);
        fs.chmodSync(path.join(agentDir, "openclaw-agent.sqlite"), 0o600);
        return false;
    }
    await writeAuthProfileStore(agentDir, {
        ...current,
        profiles,
    });
    return true;
}
function projectAgentModelsJson(agentDir, providers) {
    const modelsPath = path.join(agentDir, "models.json");
    let current = {};
    if (fs.existsSync(modelsPath)) {
        current = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    }
    const desired = { providers };
    if (JSON.stringify(current) === JSON.stringify(desired)) {
        fs.chmodSync(agentDir, 0o700);
        fs.chmodSync(modelsPath, 0o600);
        return false;
    }
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(modelsPath, `${JSON.stringify(desired, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(agentDir, 0o700);
    fs.chmodSync(modelsPath, 0o600);
    return true;
}
function readPersistedSessions(openclawDir, agentId) {
    const sessionsPath = path.join(openclawDir, "agents", agentId, "sessions", "sessions.json");
    if (!fs.existsSync(sessionsPath))
        return null;
    const raw = fs.readFileSync(sessionsPath, "utf8");
    let sessions;
    try {
        sessions = JSON.parse(raw);
    }
    catch {
        throw new Error(`customer oauth purge: ${sessionsPath} is not valid JSON`);
    }
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
        throw new Error(`customer oauth purge: ${sessionsPath} is not a session map`);
    }
    return { sessionsPath, sessions: sessions };
}
function recordValue(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function unsupportedProvider(provider, allowedProviderIds) {
    if (typeof provider !== "string" || allowedProviderIds.size === 0)
        return false;
    return !allowedProviderIds.has(provider);
}
function unsupportedModel(provider, model, allowedModelRefs) {
    if (typeof model !== "string" || allowedModelRefs.size === 0)
        return false;
    if (allowedModelRefs.has(model))
        return false;
    return typeof provider !== "string" || !allowedModelRefs.has(`${provider}/${model}`);
}
function directAgentRuntime(runtimeId) {
    if (typeof runtimeId !== "string")
        return false;
    return runtimeId.trim().length > 0 && runtimeId !== "openclaw";
}
function unsafeSessionModelSelection(entry, directRuntimeModelRefs, allowedModelRefs, allowedProviderIds) {
    const providers = [entry.providerOverride, entry.modelProvider];
    if (providers.some((provider) => provider === "claude-cli" ||
        provider === "openai-codex" ||
        unsupportedProvider(provider, allowedProviderIds)))
        return true;
    const selections = [
        [entry.providerOverride, entry.modelOverride],
        [entry.modelProvider, entry.model],
        [entry.providerOverride, entry.modelOverrideFallbackOriginModel],
    ];
    if (selections.some(([provider, model]) => unsupportedModel(provider, model, allowedModelRefs))) {
        return true;
    }
    return selections.some(([, model]) => typeof model === "string" &&
        (model.startsWith("claude-cli/") || directRuntimeModelRefs.has(model)));
}
function unsafeSessionExecutionState(entry) {
    const executableFields = [
        entry.toolOverrides,
        entry.execHost,
        entry.execSecurity,
        entry.execAsk,
        entry.execNode,
        entry.execCwd,
        entry.elevatedLevel,
        entry.acpSessionBinding,
        entry.acp,
        entry.pluginExtensions,
    ];
    if (executableFields.some((state) => state !== undefined))
        return true;
    const sessionRuntimeIds = [
        ...Object.keys(recordValue(entry.cliSessionIds)),
        ...Object.keys(recordValue(entry.cliSessionBindings)),
    ];
    return directAgentRuntime(entry.agentRuntimeOverride) ||
        directAgentRuntime(entry.agentHarnessId) ||
        sessionRuntimeIds.some(directAgentRuntime) ||
        entry.pluginOwnerId === "codex" ||
        typeof entry.claudeCliSessionId === "string";
}
function unsafeSessionAuthProfile(entry) {
    const profile = entry.authProfileOverride;
    return typeof profile === "string" && !CANONICAL_AGENT_AUTH_PROFILE_IDS.has(profile);
}
function unsafeSessionFallback(entry, directRuntimeModelRefs, allowedModelRefs) {
    const fallback = recordValue(entry.modelFallback);
    if (fallback.prevProvider === "claude-cli" || fallback.prevProvider === "openai-codex")
        return true;
    const profile = fallback.prevAuthProfileOverride;
    if (typeof profile === "string" && !CANONICAL_AGENT_AUTH_PROFILE_IDS.has(profile))
        return true;
    const model = fallback.prevModel;
    if (typeof model !== "string")
        return false;
    if (model.startsWith("claude-cli/") || directRuntimeModelRefs.has(model))
        return true;
    return unsupportedModel(fallback.prevProvider, model, allowedModelRefs);
}
function sessionUsesCustomerOauthRuntime(value, directRuntimeModelRefs, allowedModelRefs, allowedProviderIds) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const entry = value;
    return [
        unsafeSessionModelSelection(entry, directRuntimeModelRefs, allowedModelRefs, allowedProviderIds),
        unsafeSessionExecutionState(entry),
        unsafeSessionAuthProfile(entry),
        unsafeSessionFallback(entry, directRuntimeModelRefs, allowedModelRefs),
    ].some(Boolean);
}
function clearSessionRuntimeState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const entry = value;
    let changed = false;
    for (const field of SESSION_RUNTIME_STATE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(entry, field)) {
            delete entry[field];
            changed = true;
        }
    }
    return changed;
}
function resetPersistedSessions(persisted) {
    if (!persisted)
        return 0;
    const { sessionsPath, sessions } = persisted;
    const resetCount = Object.keys(sessions).length;
    if (resetCount === 0)
        return 0;
    const tmpPath = `${sessionsPath}.oauth-purge.tmp`;
    try {
        fs.writeFileSync(tmpPath, "{}\n", { mode: 0o600 });
        fs.chmodSync(tmpPath, 0o600);
        fs.renameSync(tmpPath, sessionsPath);
    }
    catch (error) {
        removeTempFile(tmpPath);
        throw error;
    }
    return resetCount;
}
const SESSION_SCRUB_BUSY_TIMEOUT_MS = 30_000;
async function scrubUnsafeAgentSessions(openclawDir, agentId, directRuntimeModelRefs, allowedModelRefs, allowedProviderIds) {
    const dbPath = path.join(openclawDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
    if (!fs.existsSync(dbPath))
        return 0;
    const anchor = readPostgresAgentAnchor(dbPath);
    if (anchor)
        return writeAgentStore(anchor, async (client, schema) => {
            const { rows } = await client.query(`SELECT session_key, entry_json FROM ${schema}.session_nodes FOR UPDATE`);
            let scrubbed = 0;
            for (const row of rows) {
                const entry = typeof row.entry_json === "string" ? JSON.parse(row.entry_json) : row.entry_json;
                if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                    throw new Error(`customer oauth purge: ${dbPath} session ${String(row.session_key)} is not an object`);
                }
                if (!sessionUsesCustomerOauthRuntime(entry, directRuntimeModelRefs, allowedModelRefs, allowedProviderIds) ||
                    !clearSessionRuntimeState(entry))
                    continue;
                await client.query(`UPDATE ${schema}.session_nodes SET entry_json = $1 WHERE session_key = $2`, [JSON.stringify(entry), row.session_key]);
                scrubbed++;
            }
            return scrubbed;
        });
    const db = new DatabaseSync(dbPath);
    try {
        db.exec(`PRAGMA busy_timeout = ${SESSION_SCRUB_BUSY_TIMEOUT_MS};`);
        const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_nodes'").get();
        if (!table)
            return 0;
        const rows = db.prepare("SELECT session_key, entry_json FROM session_nodes").all();
        const update = db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?");
        let scrubbed = 0;
        db.exec("BEGIN IMMEDIATE");
        for (const row of rows) {
            if (typeof row.entry_json !== "string")
                continue;
            let entry;
            try {
                entry = JSON.parse(row.entry_json);
            }
            catch {
                throw new Error(`customer oauth purge: ${dbPath} session ${String(row.session_key)} is not valid JSON`);
            }
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                throw new Error(`customer oauth purge: ${dbPath} session ${String(row.session_key)} is not an object`);
            }
            if (!sessionUsesCustomerOauthRuntime(entry, directRuntimeModelRefs, allowedModelRefs, allowedProviderIds) ||
                !clearSessionRuntimeState(entry))
                continue;
            update.run(JSON.stringify(entry), row.session_key);
            scrubbed++;
        }
        db.exec("COMMIT");
        return scrubbed;
    }
    catch (error) {
        try {
            db.exec("ROLLBACK");
        }
        catch {
            // The original error is more useful when no transaction was active.
        }
        throw error;
    }
    finally {
        db.close();
    }
}
function purgeNativeCredentialArtifacts(homeDir, agentIds, affectedAgentIds) {
    const nativeCredential = claudeCliNativeCredentialsPath(homeDir);
    let removedFiles = 0;
    for (const candidate of [nativeCredential, `${nativeCredential}.tmp`]) {
        if (removeIfPresent(candidate))
            removedFiles++;
    }
    if (removedFiles > 0)
        agentIds.forEach((agentId) => affectedAgentIds.add(agentId));
    return removedFiles;
}
async function purgeAgentOauthRuntime(opts, agentId, runtime) {
    const persistedSessions = readPersistedSessions(opts.openclawDir, agentId);
    const unsafePersistedSession = Object.values(persistedSessions?.sessions ?? {}).some((session) => sessionUsesCustomerOauthRuntime(session, runtime.directRuntimeModelRefs, runtime.allowedModelRefs, runtime.allowedProviderIds));
    if (unsafePersistedSession)
        runtime.affectedAgentIds.add(agentId);
    let resetSessions = await scrubUnsafeAgentSessions(opts.openclawDir, agentId, runtime.directRuntimeModelRefs, runtime.allowedModelRefs, runtime.allowedProviderIds);
    let removedFiles = 0;
    const authJson = codexAuthJsonPath(opts.openclawDir, agentId);
    for (const candidate of [authJson, `${authJson}.tmp`, `${authJson}.promote.tmp`]) {
        if (!removeIfPresent(candidate))
            continue;
        removedFiles++;
        runtime.affectedAgentIds.add(agentId);
    }
    const removedDirectories = removeDirIfPresent(codexStagingHomeDir(opts.openclawDir, agentId))
        ? 1
        : 0;
    if (removedDirectories > 0)
        runtime.affectedAgentIds.add(agentId);
    const agentDir = codexAgentDir(opts.openclawDir, agentId);
    const scrubbedProfileStores = await scrubOauthProfiles(agentDir, agentId) ? 1 : 0;
    if (scrubbedProfileStores > 0)
        runtime.affectedAgentIds.add(agentId);
    if (projectAgentModelsJson(agentDir, opts.modelProviders ?? {})) {
        runtime.affectedAgentIds.add(agentId);
    }
    if (opts.resetSessionStores !== false && runtime.affectedAgentIds.has(agentId)) {
        resetSessions += resetPersistedSessions(persistedSessions);
    }
    return { removedFiles, removedDirectories, scrubbedProfileStores, resetSessions };
}
export async function purgeCustomerOauthRuntimeArtifacts(opts) {
    const agentIds = Array.from(new Set(opts.agentIds));
    for (const agentId of agentIds) {
        if (!isSafeAgentId(agentId)) {
            throw new Error(`customer oauth purge: unsafe agent id ${JSON.stringify(agentId)}`);
        }
    }
    let removedFiles = 0;
    let removedDirectories = 0;
    let scrubbedProfileStores = 0;
    let resetSessions = 0;
    const affectedAgentIds = new Set();
    const directRuntimeModelRefs = new Set(opts.directRuntimeModelRefs ?? []);
    const allowedModelRefs = new Set(opts.allowedModelRefs ?? []);
    const allowedProviderIds = new Set(opts.allowedProviderIds ?? []);
    removedFiles += purgeNativeCredentialArtifacts(opts.homeDir, agentIds, affectedAgentIds);
    for (const agentId of agentIds) {
        const result = await purgeAgentOauthRuntime(opts, agentId, {
            directRuntimeModelRefs,
            allowedModelRefs,
            allowedProviderIds,
            affectedAgentIds,
        });
        removedFiles += result.removedFiles;
        removedDirectories += result.removedDirectories;
        scrubbedProfileStores += result.scrubbedProfileStores;
        resetSessions += result.resetSessions;
    }
    return {
        removedFiles,
        removedDirectories,
        scrubbedProfileStores,
        resetSessions,
        affectedAgentIds: [...affectedAgentIds],
    };
}
// codexAuthProfilesPath retired in 2026.6 — auth-profiles is now a SQLite
// row in {agentDir}/openclaw-agent.sqlite (upstream PR #89102). Use
// readAuthProfileStore / writeAuthProfileStore from auth-profile-store.ts.
/**
 * Reads the codex auth-state payload as text — preferring the SQLite
 * auth_profile_state row (openclaw v2026.6.5+) and falling back to the
 * legacy auth-state.json file when the SQLite row is absent. Returns null
 * when neither source has data.
 *
 * Keeps the text-in / health-out contract of `deriveCodexAuthHealth`
 * unchanged.
 */
export async function readCodexAuthStateText(openclawDir, agentId) {
    const stateRow = await readAuthProfileState(codexAgentDir(openclawDir, agentId));
    if (stateRow !== null)
        return JSON.stringify(stateRow);
    try {
        return fs.readFileSync(codexAuthStatePath(openclawDir, agentId), "utf8");
    }
    catch {
        return null;
    }
}
export function shouldRestoreCodexCredential(opts) {
    if (!opts.usableCodexProfilePresent)
        return "write";
    if (deriveCodexAuthHealth(opts.authStateText, opts.profileId, opts.now) ===
        "needs_reauth") {
        return "write";
    }
    return "skip";
}
function removeTempFile(tmp) {
    if (!tmp)
        return;
    try {
        fs.rmSync(tmp, { force: true });
    }
    catch {
        // best-effort temp cleanup
    }
}
function ensurePrivateDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
}
function profileStoreProfiles(store) {
    const profiles = store?.profiles;
    return profiles && typeof profiles === "object" && !Array.isArray(profiles)
        ? profiles
        : null;
}
function hasUsableCodexDefaultProfile(store) {
    const profile = profileStoreProfiles(store)?.[OPENAI_CODEX_DEFAULT_PROFILE_ID];
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
        return false;
    }
    const fields = profile;
    return (fields.type === "oauth" &&
        typeof fields.access === "string" &&
        fields.access.length > 0 &&
        typeof fields.refresh === "string" &&
        fields.refresh.length > 0);
}
async function alignCodexProfileProvider(agentDir, store, onAligned) {
    if (!hasUsableCodexDefaultProfile(store))
        return;
    const profile = profileStoreProfiles(store)[OPENAI_CODEX_DEFAULT_PROFILE_ID];
    if (profile.provider === "openai")
        return;
    profile.provider = "openai";
    await writeAuthProfileStore(agentDir, store);
    onAligned();
}
async function writeMergedAuthProfileStore(agentDir, next, acceptExisting) {
    const nextProfiles = profileStoreProfiles(next);
    const existing = await readAuthProfileStore(agentDir);
    if (acceptExisting && !acceptExisting(existing))
        return false;
    if (!nextProfiles) {
        await writeAuthProfileStore(agentDir, next);
        return true;
    }
    const existingProfiles = profileStoreProfiles(existing);
    await writeAuthProfileStore(agentDir, {
        ...next,
        profiles: { ...(existingProfiles ?? {}), ...nextProfiles },
    });
    return true;
}
async function restoreClaudeCliCredential(opts) {
    const nativeTarget = opts.nativeHomeDir
        ? claudeCliNativeCredentialsPath(opts.nativeHomeDir)
        : undefined;
    const nativeJson = nativeTarget
        ? buildClaudeCliNativeCredentialsJson(opts.payload)
        : null;
    let nativeTmp;
    try {
        if (nativeTarget && nativeJson !== null) {
            ensurePrivateDir(path.dirname(nativeTarget));
            nativeTmp = `${nativeTarget}.tmp`;
            fs.writeFileSync(nativeTmp, nativeJson, { mode: 0o600 });
            fs.chmodSync(nativeTmp, 0o600);
        }
        await writeMergedAuthProfileStore(opts.agentDir, buildClaudeCliAuthProfilesStore(opts.payload, Date.now()));
        if (nativeTarget && nativeTmp) {
            fs.renameSync(nativeTmp, nativeTarget);
            fs.chmodSync(nativeTarget, 0o600);
            nativeTmp = undefined;
        }
        return { nativeRestored: Boolean(nativeTarget && nativeJson !== null) };
    }
    catch (err) {
        removeTempFile(nativeTmp);
        throw err;
    }
}
function codexProfile(store) {
    const profile = profileStoreProfiles(store)?.[OPENAI_CODEX_DEFAULT_PROFILE_ID];
    return profile && typeof profile === "object" ? profile : {};
}
function codexProfileExpired(store) {
    const { expires } = codexProfile(store);
    return typeof expires === "number" && Number.isFinite(expires) && expires > 0 && expires <= Date.now();
}
function canReplaceExpiredCodexCredential(current, next) {
    const before = codexProfile(current);
    const after = codexProfile(next);
    if (typeof after.expires !== "number" || after.expires <= Date.now() || before.access === after.access)
        return false;
    if (typeof before.refresh !== "string")
        return false;
    if (!before.refresh.startsWith("openclaw-oauth-refresh-fence:v1:"))
        return before.refresh !== after.refresh;
    const failed = /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:failed:refresh:([a-f0-9]{64})$/u.exec(before.refresh);
    if (!failed)
        return false;
    const generation = createHash("sha256").update(JSON.stringify([
        "openclaw.oauth-refresh-generation", 1, OPENAI_CODEX_DEFAULT_PROFILE_ID, before.provider, "refresh", after.refresh,
    ])).digest("hex");
    return failed[1] !== generation;
}
async function restoreCodexCredential(payload, agentDir, compare) {
    const next = buildCodexAuthProfilesStore(payload);
    return writeMergedAuthProfileStore(agentDir, next, compare
        ? current => codexProfileExpired(current) && canReplaceExpiredCodexCredential(current, next)
        : undefined);
}
export function removeStaleCodexAuthJson(openclawDir, agentId) {
    const authJson = codexAuthJsonPath(openclawDir, agentId);
    let removed = false;
    for (const candidate of [authJson, `${authJson}.tmp`, `${authJson}.promote.tmp`]) {
        removed = removeIfPresent(candidate) || removed;
    }
    return removed;
}
async function planCodexRestore(item, agentDir, log) {
    if (removeStaleCodexAuthJson(item.openclawDir, item.agentId)) {
        log(`byosub: removed the stale codex-home auth.json for ${item.agentId} (OpenClaw reads only its auth store)`);
    }
    const store = await readAuthProfileStore(agentDir);
    const usableCodexProfilePresent = hasUsableCodexDefaultProfile(store);
    await alignCodexProfileProvider(agentDir, store, () => {
        log(`byosub: aligned ${item.agentId} ChatGPT credential with the OpenAI runtime provider`);
    });
    const action = shouldRestoreCodexCredential({
        usableCodexProfilePresent,
        authStateText: await readCodexAuthStateText(item.openclawDir, item.agentId),
        profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
        now: Date.now(),
    });
    return usableCodexProfilePresent && codexProfileExpired(store) ? "compare" : action;
}
export async function restoreByosubCredentials(opts) {
    const log = opts.logFn ?? (() => { });
    let restored = 0;
    let failed = 0;
    let skipped = 0;
    for (const item of opts.plan) {
        const agentDir = codexAgentDir(item.openclawDir, item.agentId);
        let codexAction;
        try {
            if (item.provider === "openai") {
                codexAction = await planCodexRestore(item, agentDir, log);
                if (codexAction === "skip") {
                    skipped++;
                    log(`byosub: ${item.agentId} healthy on-disk credential — conservative skip (openclaw owns it; not clobbering)`);
                    continue;
                }
            }
            const payload = await opts.fetchSecret(item.secretName);
            if (item.provider === "anthropic") {
                const { nativeRestored } = await restoreClaudeCliCredential({
                    agentDir,
                    payload,
                    ...(opts.claudeCliNativeHomeDir
                        ? { nativeHomeDir: opts.claudeCliNativeHomeDir }
                        : {}),
                });
                restored++;
                log(`byosub: restored claude-cli credential for ${item.agentId}${nativeRestored ? " (native Claude CLI credential restored)" : ""}`);
                continue;
            }
            const restoredProfile = await restoreCodexCredential(payload, agentDir, codexAction === "compare");
            if (!restoredProfile) {
                skipped++;
                log(`byosub: ${item.agentId} expired credential preserved — no fresh replacement generation`);
                continue;
            }
            restored++;
            log(`byosub: restored ${item.provider} credential for ${item.agentId}`);
        }
        catch (e) {
            failed++;
            log(`byosub: WARN failed to restore ${item.agentId} (${item.secretName}) — ${e.message}`);
        }
    }
    return { restored, failed, skipped };
}
