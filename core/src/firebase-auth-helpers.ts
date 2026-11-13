

export interface AuthDeleter {
  deleteUser: (uid: string) => Promise<unknown>;
}

export interface AuthSuspender {
  updateUser: (
    uid: string,
    properties: { disabled: boolean },
  ) => Promise<unknown>;
  revokeRefreshTokens: (uid: string) => Promise<unknown>;
}

export async function deleteAuthUserTolerantOfMissing(
  uid: string,
  auth: AuthDeleter,
): Promise<void> {
  try {
    await auth.deleteUser(uid);
  } catch (err) {
    const code = (err as { code?: string } | null | undefined)?.code;
    if (code !== "auth/user-not-found") throw err;
  }
}

export async function disableAuthUserAndRevokeSessions(
  uid: string,
  auth: AuthSuspender,
): Promise<void> {
  try {
    await auth.updateUser(uid, { disabled: true });
  } catch (err) {
    const code = (err as { code?: string } | null | undefined)?.code;
    if (code === "auth/user-not-found") return;
    throw err;
  }
  await auth.revokeRefreshTokens(uid);
}
