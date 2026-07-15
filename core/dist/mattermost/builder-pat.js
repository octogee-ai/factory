export const BUILDER_PAT_DESCRIPTION = "Octogee workspace chat";
export async function revokeAndMintBuilderPat(deps, uid, builderMmUserId) {
    const log = deps.log ?? (() => { });
    if (!builderMmUserId) {
        return { outcome: 'mm-user-missing' };
    }
    const revokedTokenIds = await revokeStaleBuilderTokens(deps, builderMmUserId);
    let mintResult;
    try {
        mintResult = await deps.mmApiCall('POST', `/users/${builderMmUserId}/tokens`, { description: BUILDER_PAT_DESCRIPTION });
    }
    catch (err) {
        log(`[builder-pat] mint failed for ${builderMmUserId}: ${err instanceof Error ? err.message : String(err)}`);
        return { outcome: 'mint-failed', revokedTokenIds };
    }
    const token = mintResult && typeof mintResult === 'object' && typeof mintResult.token === 'string'
        ? mintResult.token
        : '';
    if (!token) {
        return { outcome: 'mint-failed', revokedTokenIds };
    }
    await deps.writeBuilderSecret(uid, { personalToken: token, rotatedAt: deps.now() });
    return {
        outcome: 'rotated',
        newTokenLastFour: token.slice(-4),
        revokedTokenIds,
    };
}
async function revokeStaleBuilderTokens(deps, builderMmUserId) {
    const log = deps.log ?? (() => { });
    let listed;
    try {
        listed = await deps.mmApiCall('GET', `/users/${builderMmUserId}/tokens`);
    }
    catch (err) {
        log(`[builder-pat] list tokens failed for ${builderMmUserId}: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
    if (!Array.isArray(listed))
        return [];
    const stale = listed.filter((t) => t?.description === BUILDER_PAT_DESCRIPTION && typeof t?.id === 'string');
    const revoked = [];
    for (const t of stale) {
        const tokenId = t.id;
        try {
            await deps.mmApiCall('POST', '/users/tokens/revoke', { token_id: tokenId });
            revoked.push(tokenId);
        }
        catch (err) {
            log(`[builder-pat] revoke ${tokenId} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return revoked;
}
