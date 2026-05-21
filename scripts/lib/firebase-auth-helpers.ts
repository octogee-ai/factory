/**
 * Shared firebase-admin/auth helpers used by both gateway-edge and
 * glm-controller. Dep-injected so tests don't need a Firebase instance.
 */

export interface AuthDeleter {
  deleteUser: (uid: string) => Promise<unknown>;
}

/**
 * Deletes a Firebase Auth user, tolerating `auth/user-not-found`. Used
 * by the admin delete-customer flow's inline lite-delete branch (raw
 * signups with no slug ever assigned) where the auth record may have
 * been cleaned up out-of-band already.
 */
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
