import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { buildCodexAuthJsonFromStore, buildCodexAuthProfilesStore, buildClaudeCliAuthProfilesStore, buildClaudeCliNativeCredentialsJson, OPENAI_CODEX_DEFAULT_PROFILE_ID, } from "./model-credential-materializer.js";
import { readAuthProfileState, readAuthProfileStore, writeAuthProfileStore, } from "./auth-profile-sqlite.js";
import { deriveCodexAuthHealth } from "./codex-auth-health.js";
import { agentModelTokenProfileEntry, openAiBrokerProfileEntry, openRouterBrokerProfileEntry, } from "./agent-model-token-materializer.js";
export function agentIdsFromConfig(config) {
    const agents = config?.agents;
    const ids = new Set();
    if (Array.isArray(agents?.list)) {
        for (const agent of agents.list) {
            const id = agent && typeof agent === "object"
                ? agent.id
                : undefined;
            if (typeof id === "string" && id.length > 0)
                ids.add(id);
        }
    }
    if (agents?.entries &&
        typeof agents.entries === "object" &&
        !Array.isArray(agents.entries)) {
        for (const id of Object.keys(agents.entries)) {
            if (id.length > 0)
                ids.add(id);
        }
    }
    return [...ids];
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
export function codexAuthStatePath(openclawDir, agentId) {
    return path.join(codexAgentDir(openclawDir, agentId), "auth-state.json");
}
const CANONICAL_AGENT_AUTH_PROFILE_IDS = new Set([
    "anthropic:default",
    "platform-openrouter:default",
    "platform-openai:default",
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
function scrubOauthProfiles(agentDir, agentId) {
    const store = readAuthProfileStore(agentDir);
    const current = store && typeof store === "object" && !Array.isArray(store)
        ? store
        : {};
    const profiles = {
        "anthropic:default": agentModelTokenProfileEntry(agentId),
        "platform-openrouter:default": openRouterBrokerProfileEntry(agentId),
        "platform-openai:default": openAiBrokerProfileEntry(agentId),
    };
    if (JSON.stringify(current.profiles) === JSON.stringify(profiles)) {
        fs.chmodSync(agentDir, 0o700);
        fs.chmodSync(path.join(agentDir, "openclaw-agent.sqlite"), 0o600);
        return false;
    }
    writeAuthProfileStore(agentDir, {
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
function scrubUnsafeSqliteSessions(openclawDir, agentId, directRuntimeModelRefs, allowedModelRefs, allowedProviderIds) {
    const dbPath = path.join(openclawDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
    if (!fs.existsSync(dbPath))
        return 0;
    const db = new DatabaseSync(dbPath);
    try {
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
function purgeAgentOauthRuntime(opts, agentId, runtime) {
    const persistedSessions = readPersistedSessions(opts.openclawDir, agentId);
    const unsafePersistedSession = Object.values(persistedSessions?.sessions ?? {}).some((session) => sessionUsesCustomerOauthRuntime(session, runtime.directRuntimeModelRefs, runtime.allowedModelRefs, runtime.allowedProviderIds));
    if (unsafePersistedSession)
        runtime.affectedAgentIds.add(agentId);
    let resetSessions = scrubUnsafeSqliteSessions(opts.openclawDir, agentId, runtime.directRuntimeModelRefs, runtime.allowedModelRefs, runtime.allowedProviderIds);
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
    const scrubbedProfileStores = scrubOauthProfiles(agentDir, agentId) ? 1 : 0;
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
export function purgeCustomerOauthRuntimeArtifacts(opts) {
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
        const result = purgeAgentOauthRuntime(opts, agentId, {
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
// readAuthProfileStore / writeAuthProfileStore from auth-profile-sqlite.ts.
/**
 * Reads the codex auth-state payload as text — preferring the SQLite
 * auth_profile_state row (openclaw v2026.6.5+) and falling back to the
 * legacy auth-state.json file when the SQLite row is absent. Returns null
 * when neither source has data.
 *
 * Single source for both the restore decision (byosub-restore) and the
 * gateway-side health sweep (codex-auth-health-io). Keeps the text-in /
 * health-out contract of `deriveCodexAuthHealth` unchanged.
 */
export function readCodexAuthStateText(openclawDir, agentId) {
    const stateRow = readAuthProfileState(codexAgentDir(openclawDir, agentId));
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
    if (opts.targetPathPresent === false)
        return "materialize";
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
        fields.provider === "openai-codex" &&
        typeof fields.access === "string" &&
        fields.access.length > 0 &&
        typeof fields.refresh === "string" &&
        fields.refresh.length > 0);
}
function writeMergedAuthProfileStore(agentDir, next) {
    const nextProfiles = profileStoreProfiles(next);
    if (!nextProfiles) {
        writeAuthProfileStore(agentDir, next);
        return;
    }
    const existingProfiles = profileStoreProfiles(readAuthProfileStore(agentDir));
    writeAuthProfileStore(agentDir, {
        ...next,
        profiles: { ...(existingProfiles ?? {}), ...nextProfiles },
    });
}
function restoreClaudeCliCredential(opts) {
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
        writeMergedAuthProfileStore(opts.agentDir, buildClaudeCliAuthProfilesStore(opts.payload, Date.now()));
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
function restoreCodexCredential(item, payload, agentDir) {
    const targetPath = item.targetPath;
    let tmp;
    try {
        tmp = `${targetPath}.tmp`;
        const codexStore = buildCodexAuthProfilesStore(payload);
        ensurePrivateDir(path.dirname(targetPath));
        fs.writeFileSync(tmp, payload, { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        // Write SQLite BEFORE promoting codex-home — preserves cross-pair
        // atomicity (the Copilot #989 invariant): if the auth-profiles store
        // can't be written, codex-home stays unpromoted, so we never half-flip
        // routing.
        writeMergedAuthProfileStore(agentDir, codexStore);
        fs.renameSync(tmp, targetPath);
        tmp = undefined;
    }
    catch (err) {
        removeTempFile(tmp);
        throw err;
    }
}
function materializeCodexAuthJson(targetPath, store) {
    const payload = buildCodexAuthJsonFromStore(JSON.stringify(store));
    if (payload === null) {
        throw new Error("usable openai-codex:default profile could not be materialized");
    }
    let tmp;
    try {
        ensurePrivateDir(path.dirname(targetPath));
        tmp = `${targetPath}.tmp`;
        fs.writeFileSync(tmp, payload, { mode: 0o600 });
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, targetPath);
        tmp = undefined;
    }
    catch (err) {
        removeTempFile(tmp);
        throw err;
    }
}
export async function restoreByosubCredentials(opts) {
    const log = opts.logFn ?? (() => { });
    let restored = 0;
    let failed = 0;
    let skipped = 0;
    for (const item of opts.plan) {
        const agentDir = codexAgentDir(item.openclawDir, item.agentId);
        let codexAction;
        let codexStore;
        if (item.provider === "openai") {
            codexStore = readAuthProfileStore(agentDir);
            const usableCodexProfilePresent = hasUsableCodexDefaultProfile(codexStore);
            const authStateText = readCodexAuthStateText(item.openclawDir, item.agentId);
            codexAction = shouldRestoreCodexCredential({
                usableCodexProfilePresent,
                authStateText,
                profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
                now: Date.now(),
                targetPathPresent: fs.existsSync(item.targetPath),
            });
            if (codexAction === "skip") {
                skipped++;
                log(`byosub: ${item.agentId} healthy on-disk credential — conservative skip (openclaw owns it; not clobbering)`);
                continue;
            }
        }
        try {
            if (codexAction === "materialize") {
                materializeCodexAuthJson(item.targetPath, codexStore);
                restored++;
                log(`byosub: materialized ${item.provider} credential for ${item.agentId} from the healthy profile store`);
                continue;
            }
            const payload = await opts.fetchSecret(item.secretName);
            if (item.provider === "anthropic") {
                const { nativeRestored } = restoreClaudeCliCredential({
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
            restoreCodexCredential(item, payload, agentDir);
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
