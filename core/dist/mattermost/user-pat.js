export const USER_PAT_DESCRIPTION = "Octogee workspace chat";
export async function revokeAndMintUserPat(deps, uid, userMmUserId) {
    const log = deps.log ?? (() => { });
    if (!userMmUserId) {
        return { outcome: 'mm-user-missing' };
    }
    const revokedTokenIds = await revokeStaleUserTokens(deps, userMmUserId);
    let mintResult;
    try {
        mintResult = await deps.mmApiCall('POST', `/users/${userMmUserId}/tokens`, { description: USER_PAT_DESCRIPTION });
    }
    catch (err) {
        log(`[user-pat] mint failed for ${userMmUserId}: ${err instanceof Error ? err.message : String(err)}`);
        return { outcome: 'mint-failed', revokedTokenIds };
    }
    const token = mintResult && typeof mintResult === 'object' && typeof mintResult.token === 'string'
        ? mintResult.token
        : '';
    if (!token) {
        return { outcome: 'mint-failed', revokedTokenIds };
    }
    await deps.writeUserSecret(uid, { personalToken: token, rotatedAt: deps.now() });
    return {
        outcome: 'rotated',
        newTokenLastFour: token.slice(-4),
        revokedTokenIds,
    };
}
async function revokeStaleUserTokens(deps, userMmUserId) {
    const log = deps.log ?? (() => { });
    let listed;
    try {
        listed = await deps.mmApiCall('GET', `/users/${userMmUserId}/tokens`);
    }
    catch (err) {
        log(`[user-pat] list tokens failed for ${userMmUserId}: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
    if (!Array.isArray(listed))
        return [];
    const stale = listed.filter((t) => t?.description === USER_PAT_DESCRIPTION && typeof t?.id === 'string');
    const revoked = [];
    for (const t of stale) {
        const tokenId = t.id;
        try {
            await deps.mmApiCall('POST', '/users/tokens/revoke', { token_id: tokenId });
            revoked.push(tokenId);
        }
        catch (err) {
            log(`[user-pat] revoke ${tokenId} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return revoked;
}
