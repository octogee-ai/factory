import { beforeAll } from "vitest";
import { UserCredentialRejected, type UserIdentityProvider } from "@octogee/core/user-identity-provider";

const firebaseUserIdentity: UserIdentityProvider = {
  verifyBearer: async (token) => {
    const { auth } = await import("../lib/db.js");
    let decoded: Awaited<ReturnType<typeof auth.verifyIdToken>>;
    try {
      decoded = await auth.verifyIdToken(token);
    } catch (error) {
      throw new UserCredentialRejected(error instanceof Error ? error.message : String(error));
    }
    return { uid: decoded.uid, authTime: Number.isSafeInteger(decoded.auth_time) ? decoded.auth_time : null };
  },
  loadUser: async (uid) => {
    const [{ db }, { platformStateStore }, { userDataWithUserState }] = await Promise.all([
      import("../lib/db.js"),
      import("../lib/platform-state.js"),
      import("../lib/user-platform-state.js"),
    ]);
    const [userSnap, userRecord] = await Promise.all([
      db.collection("users").doc(uid).get(),
      platformStateStore.users.records.get(uid),
    ]);
    return userSnap.exists ? userDataWithUserState(userSnap.data()!, userRecord) : null;
  },
};

beforeAll(async () => {
  const { installUserIdentityProvider } = await import("../middleware/auth.js");
  installUserIdentityProvider(firebaseUserIdentity);
});
