function revocableCiphertext(data) {
    const tokens = data?.tokens;
    if (typeof tokens?.encryptedRefreshToken === "string" && tokens.encryptedRefreshToken.length > 0) {
        return tokens.encryptedRefreshToken;
    }
    if (typeof tokens?.encryptedAccessToken === "string" && tokens.encryptedAccessToken.length > 0) {
        return tokens.encryptedAccessToken;
    }
    return null;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export async function revokeProviderGrant(uid, target, deps) {
    try {
        const snapshot = await deps.db
            .collection("users")
            .doc(uid)
            .collection("secrets")
            .doc(target.connectorId)
            .get();
        const ciphertext = revocableCiphertext(snapshot.data());
        if (ciphertext === null)
            return;
        const response = await (deps.fetchImpl ?? fetch)(target.revocationUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: await deps.decryptSecret(ciphertext) }),
            signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000),
        });
        if (!response.ok) {
            deps.logger.warn(`[connect] ${target.connectorId} provider revoke returned ${response.status} for uid=${uid}`);
        }
    }
    catch (error) {
        deps.logger.warn(`[connect] ${target.connectorId} provider revoke failed for uid=${uid}: ${errorMessage(error)}`);
    }
}
export async function revokeAllConnectorGrantsForUser(uid, targets, deps) {
    for (const target of targets) {
        await revokeProviderGrant(uid, target, deps);
    }
}
