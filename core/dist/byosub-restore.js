import * as fs from "fs";
import * as path from "path";
import { buildCodexAuthJsonFromStore, buildCodexAuthProfilesStore, buildClaudeCliAuthProfilesStore, buildClaudeCliNativeCredentialsJson, OPENAI_CODEX_DEFAULT_PROFILE_ID, } from "./model-credential-materializer.js";
import { readAuthProfileState, readAuthProfileStore, writeAuthProfileStore, } from "./auth-profile-sqlite.js";
import { deriveCodexAuthHealth } from "./codex-auth-health.js";
export function agentIdsFromConfig(config) {
    const list = config
        ?.agents?.list;
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
export function codexAuthStatePath(openclawDir, agentId) {
    return path.join(codexAgentDir(openclawDir, agentId), "auth-state.json");
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
