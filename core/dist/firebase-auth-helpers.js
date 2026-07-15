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
