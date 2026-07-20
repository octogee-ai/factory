export async function deleteAuthUserTolerantOfMissing(uid, auth) {
    try {
        await auth.deleteUser(uid);
    }
    catch (err) {
        const code = err?.code;
        if (code !== "auth/user-not-found")
            throw err;
    }
}
export async function disableAuthUserAndRevokeSessions(uid, auth) {
    try {
        await auth.updateUser(uid, { disabled: true });
    }
    catch (err) {
        const code = err?.code;
        if (code === "auth/user-not-found")
            return;
        throw err;
    }
    await auth.revokeRefreshTokens(uid);
}
