import { revokeAllConnectorGrantsForUser } from "@octogee/core/connector-revocation";
import { disableAuthUserAndRevokeSessions } from "@octogee/core/firebase-auth-helpers";
import { CONNECTOR_OAUTH_REVOCATION_TARGETS } from "@octogee/shared/types/connectors";
import { platformStateStore } from "./platform-state.js";
import { decryptSecret } from "./kms.js";
import { logger } from "../middleware/logging.js";

export const customerDeletionDeps = {
  suspendAuthUser: async (uid: string): Promise<void> => {
    const { getAuth } = await import("firebase-admin/auth");
    await disableAuthUserAndRevokeSessions(uid, getAuth());
  },
  revokeConnectorGrantsForUser: (uid: string): Promise<void> =>
    revokeAllConnectorGrantsForUser(uid, CONNECTOR_OAUTH_REVOCATION_TARGETS, {
      secrets: platformStateStore.secrets,
      decryptSecret,
      logger,
    }),
};
