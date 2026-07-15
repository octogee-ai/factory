import { projectAgentMmUsername } from "@octogee/shared/types/identity";
export const PROJECT_AGENT_PAT_DESCRIPTION = "Octogee project agent (OpenClaw)";
export function projectAgentSecretDocId(project) {
    return `projectAgentMattermost-${project}`;
}
function secretDoc(deps, uid, project) {
    return deps.db
        .collection("users").doc(uid)
        .collection("secrets").doc(projectAgentSecretDocId(project));
}
async function createOrAdoptBotUser(deps, botUsername, displayName, description) {
    let createError;
    try {
        const created = (await deps.mmApiCall("POST", "/bots", {
            username: botUsername,
            display_name: displayName,
            description,
        }));
        if (typeof created?.user_id === "string" && created.user_id)
            return created.user_id;
    }
    catch (err) {
        createError = err;
    }
    const existing = (await deps.mmApiCall("GET", `/users/username/${botUsername}`));
    if (typeof existing?.id === "string" && existing.id) {
        // MM usernames are server-global and MM does not enforce our reserved-
        // segment rules — a builder could rename their own account to squat this
        // username. Adopting a human account would hand it the project PAT.
        if (existing.is_bot !== true) {
            throw new Error(`[project-agent] username ${botUsername} is taken by a user that is not a bot - refusing to adopt`);
        }
        if (typeof existing.delete_at === "number" && existing.delete_at > 0) {
            await deps.mmApiCall("PUT", `/users/${existing.id}/active`, { active: true });
            deps.log(`[project-agent] reactivated retired bot ${botUsername} (${existing.id})`);
        }
        deps.log(`[project-agent] bot ${botUsername} already exists, adopting (${existing.id})`);
        return existing.id;
    }
    throw new Error(`[project-agent] cannot create or adopt bot ${botUsername}: ${createError instanceof Error ? createError.message : String(createError ?? "no user_id returned")}`);
}
async function revokeTokens(deps, mmUserId, matches) {
    let existing;
    try {
        existing = await deps.mmApiCall("GET", `/users/${mmUserId}/tokens`);
    }
    catch (err) {
        deps.log(`[project-agent] token listing failed for ${mmUserId} — continuing: ${err instanceof Error ? err.message : String(err)}`);
        return;
    }
    if (!Array.isArray(existing))
        return;
    for (const token of existing) {
        if (typeof token?.id !== "string" || !matches(token))
            continue;
        await deps.mmApiCall("POST", "/users/tokens/revoke", { token_id: token.id });
    }
}
export async function createProjectAgentBot(deps, input) {
    const botUsername = projectAgentMmUsername(input.username, input.project);
    const mmUserId = await createOrAdoptBotUser(deps, botUsername, input.displayName, `Octogee project agent for ${input.username}/${input.project}`);
    await deps.mmApiCall("POST", `/teams/${input.teamId}/members`, {
        team_id: input.teamId,
        user_id: mmUserId,
    });
    for (const channelId of input.projectChannelIds) {
        await deps.mmApiCall("POST", `/channels/${channelId}/members`, { user_id: mmUserId });
    }
    await revokeTokens(deps, mmUserId, (t) => t.description === PROJECT_AGENT_PAT_DESCRIPTION);
    const minted = (await deps.mmApiCall("POST", `/users/${mmUserId}/tokens`, {
        description: PROJECT_AGENT_PAT_DESCRIPTION,
    }));
    if (typeof minted?.token !== "string" || !minted.token) {
        throw new Error(`[project-agent] PAT mint returned no token for ${botUsername}`);
    }
    await secretDoc(deps, input.uid, input.project).set({
        personalToken: minted.token,
        mmUserId,
        project: input.project,
        createdAt: deps.now(),
    });
    deps.log(`[project-agent] provisioned ${botUsername} (${mmUserId}) with fresh PAT`);
    return { mmUserId, token: minted.token };
}
export async function retireProjectAgentBot(deps, input) {
    await revokeTokens(deps, input.mmUserId, () => true);
    try {
        await deps.mmApiCall("DELETE", `/users/${input.mmUserId}`);
    }
    catch (err) {
        // Already gone (hard-deleted, or a prior retire won the race) — the
        // level-triggered reconcile must not wedge on it; secret cleanup proceeds.
        if (err.status !== 404)
            throw err;
        deps.log(`[project-agent] bot ${input.mmUserId} already gone (404) - continuing retire`);
    }
    await secretDoc(deps, input.uid, input.project).delete();
    deps.log(`[project-agent] retired bot ${input.mmUserId} for project ${input.project}`);
}
