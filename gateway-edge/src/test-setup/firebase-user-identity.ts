import { UserCredentialRejected } from "@octogee/core/user-identity-provider";
import { auth, db } from "../lib/db.js";
import { platformStateStore } from "../lib/platform-state.js";
import { userDataWithUserState } from "../lib/user-platform-state.js";
import { installUserIdentityProvider } from "../middleware/auth.js";

installUserIdentityProvider({
  verifyBearer: async (token) => {
    let decoded: Awaited<ReturnType<typeof auth.verifyIdToken>>;
    try {
      decoded = await auth.verifyIdToken(token);
    } catch (error) {
      throw new UserCredentialRejected(error instanceof Error ? error.message : String(error));
    }
    return { uid: decoded.uid, authTime: Number.isSafeInteger(decoded.auth_time) ? decoded.auth_time : null };
  },
  loadUser: async (uid) => {
    const [userSnap, userRecord] = await Promise.all([
      db.collection("users").doc(uid).get(),
      platformStateStore.users.records.get(uid),
    ]);
    return userSnap.exists ? userDataWithUserState(userSnap.data()!, userRecord) : null;
  },
});
