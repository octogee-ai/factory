function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
export function deriveCodexAuthHealth(authStateText, profileId, now) {
    if (typeof authStateText !== "string" || authStateText.trim() === "") {
        return "ok";
    }
    let parsed;
    try {
        parsed = JSON.parse(authStateText);
    }
    catch {
        return "ok";
    }
    if (!isRecord(parsed) || !isRecord(parsed.usageStats)) {
        return "ok";
    }
    const stats = parsed.usageStats[profileId];
    if (!isRecord(stats) || stats.disabledReason !== "auth_permanent") {
        return "ok";
    }
    const until = stats.disabledUntil;
    if (typeof until === "number" && Number.isFinite(until) && until <= now) {
        return "ok";
    }
    return "needs_reauth";
}
export async function checkCodexAuthHealthForAgents(opts) {
    const log = opts.logFn ?? (() => { });
    let checked = 0;
    let needsReauth = 0;
    let signalled = 0;
    for (const agentId of opts.agentIds) {
        let stateText;
        try {
            stateText = opts.readAuthState(agentId);
        }
        catch (e) {
            log(`codex-auth-health: WARN read failed for ${agentId} — ${e.message}`);
            continue;
        }
        checked++;
        if (deriveCodexAuthHealth(stateText, opts.profileId, opts.now) !== "needs_reauth") {
            continue;
        }
        needsReauth++;
        try {
            await opts.signalNeedsReauth(agentId);
            signalled++;
            log(`codex-auth-health: ${agentId} codex auth dead — signalled needs_reauth`);
        }
        catch (e) {
            log(`codex-auth-health: WARN signal failed for ${agentId} — ${e.message}`);
        }
    }
    return { checked, needsReauth, signalled };
}
