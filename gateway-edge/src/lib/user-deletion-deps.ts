import { revokeAllConnectorGrantsForUser } from "@octogee/core/connector-revocation";
import { disableAuthUserAndRevokeSessions } from "@octogee/core/firebase-auth-helpers";
import { CONNECTOR_OAUTH_REVOCATION_TARGETS } from "@octogee/shared/types/connectors";
import { auth } from "./db.js";
import { platformStateStore } from "./platform-state.js";
import { decryptSecret } from "./kms.js";
import { logger } from "../middleware/logging.js";

export const userDeletionDeps = {
  suspendAuthUser: (uid: string): Promise<void> => disableAuthUserAndRevokeSessions(uid, auth),
  revokeConnectorGrantsForUser: (uid: string): Promise<void> =>
    revokeAllConnectorGrantsForUser(uid, CONNECTOR_OAUTH_REVOCATION_TARGETS, {
      secrets: platformStateStore.secrets,
      decryptSecret,
      logger,
    }),
};
