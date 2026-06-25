

export interface AuthDeleter {
  deleteUser: (uid: string) => Promise<unknown>;
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
