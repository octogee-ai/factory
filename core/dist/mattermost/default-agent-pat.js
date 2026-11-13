export const DEFAULT_AGENT_PAT_DESCRIPTION = "Octogee coach agent (OpenClaw)";
export async function mintAndPersistDefaultAgentToken(deps, uid, defaultAgentMmUserId) {
    if (!defaultAgentMmUserId)
        return null;
    await deps.channelHost.revokeTokens(defaultAgentMmUserId, DEFAULT_AGENT_PAT_DESCRIPTION);
    let token;
    try {
        token = await deps.channelHost.issueToken(defaultAgentMmUserId, DEFAULT_AGENT_PAT_DESCRIPTION);
    }
    catch {
        return null;
    }
    if (!token)
        return null;
    await deps.secrets.put(uid, {
        kind: "coach-mattermost",
        secretId: "coachMattermost",
        projectId: null,
        personalToken: token,
        mattermostUserId: defaultAgentMmUserId,
        createdAt: deps.now(),
        rotatedAt: null,
    });
    return { token };
}
